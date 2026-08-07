import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '../../src/loop/types';
import type {
  ChatCompletionChunk,
  ModelClient,
  StreamChatParams,
  Usage,
} from '../../src/model/client';
import { editFileTool } from '../../src/tools/edit';
import { readFileTool } from '../../src/tools/read';
import { ToolRegistry } from '../../src/tools/registry';
import { App } from '../../src/ui/App';
import { EditConfirm, ShellConfirm } from '../../src/ui/modals';
import { StatusBar } from '../../src/ui/StatusBar';

interface FakeReply {
  content?: string;
  toolCalls?: ToolCall[];
  /** 附加在流末尾 chunk 上的用量统计。 */
  usage?: Usage;
}

class FakeModel implements ModelClient {
  /** 置位后下一次调用直接抛错（模拟模型调用失败）。 */
  failNext: Error | undefined;

  constructor(
    private readonly script: FakeReply[],
    private readonly delayMs = 0,
  ) {}

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    if (this.failNext !== undefined) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    const reply = this.script.shift();
    if (reply === undefined) {
      throw new Error('FakeModel 脚本耗尽');
    }
    if (reply.content !== undefined) {
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }
      yield fakeChunk({ content: reply.content });
    }
    let index = 0;
    for (const tc of reply.toolCalls ?? []) {
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }
      yield fakeChunk({
        tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: tc.arguments } }],
      });
      index += 1;
    }
    yield fakeChunk({}, 'stop', reply.usage);
  }
}

/** 流式模型：首 chunk 后延迟，若期间被 abort 则抛 AbortError（模拟真实中断）。 */
class AbortableModel implements ModelClient {
  async *streamChat(params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    yield fakeChunk({ content: '第一段' });
    await sleep(150);
    if (params.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    yield fakeChunk({ content: '第二段' });
    yield fakeChunk({}, 'stop');
  }
}

function fakeChunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
  usage?: Usage,
): ChatCompletionChunk {
  return {
    id: 'fake-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: usage ?? null,
  };
}

async function waitFor(assert: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      assert();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  assert();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let tmp: string;
let registry: ToolRegistry;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
  registry = new ToolRegistry().register(readFileTool).register(editFileTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('StatusBar', () => {
  it('渲染模型名、token 数与成本', () => {
    const { lastFrame, unmount } = render(
      <StatusBar model="deepseek-v4-flash" inputTokens={100} outputTokens={50} cost={0.0012} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('模型');
    expect(frame).toContain('deepseek-v4-flash');
    expect(frame).toContain('100/50');
    expect(frame).toContain('0.0012');
    unmount();
  });
});

describe('审批框', () => {
  it('EditConfirm 显示编辑标题与 diff 详情', () => {
    const { lastFrame, unmount } = render(
      <EditConfirm summary="编辑文件 a.txt" detail={'@@ -1,1 +1,1 @@\n-old\n+new'} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('编辑文件');
    expect(frame).toContain('-old');
    expect(frame).toContain('+new');
    expect(frame).toContain('批准');
    unmount();
  });

  it('ShellConfirm 显示命令与按键提示', () => {
    const { lastFrame, unmount } = render(
      <ShellConfirm summary="执行命令: npm test" detail="npm test" />,
    );
    const frame = lastFrame();
    expect(frame).toContain('执行命令');
    expect(frame).toContain('npm test');
    expect(frame).toContain('拒绝');
    unmount();
  });
});

describe('App 集成', () => {
  it('输入 → 流式回复渲染', async () => {
    const model = new FakeModel([{ content: '你好，Lumen 就绪' }]);
    const { stdin, lastFrame, unmount } = render(
      <App client={model} registry={registry} ctx={{ cwd: tmp }} model="deepseek-v4-flash" />,
    );
    stdin.write('你好');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('你好，Lumen 就绪');
    });
    unmount();
  });

  it('空输入不发送', async () => {
    const model = new FakeModel([{ content: '不该出现' }]);
    const { stdin, lastFrame, unmount } = render(
      <App client={model} registry={registry} ctx={{ cwd: tmp }} model="deepseek-v4-flash" />,
    );
    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lastFrame()).not.toContain('不该出现');
    unmount();
  });

  it('审批流：edit_file 弹审批框，y 批准后落盘并继续', async () => {
    const model = new FakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'edit_file', arguments: '{"path":"b.txt","search":"","replace":"hi"}' },
        ],
      },
      { content: '文件已创建' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App client={model} registry={registry} ctx={{ cwd: tmp }} model="deepseek-v4-flash" />,
    );
    stdin.write('创建文件');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('编辑文件');
    });
    expect(() => readFileSync(path.join(tmp, 'b.txt'))).toThrow();
    stdin.write('y');
    await waitFor(() => {
      expect(lastFrame()).toContain('文件已创建');
    });
    expect(readFileSync(path.join(tmp, 'b.txt'), 'utf8')).toBe('hi');
    unmount();
  });

  it('审批流：n 拒绝不落盘', async () => {
    const model = new FakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'edit_file', arguments: '{"path":"b.txt","search":"","replace":"hi"}' },
        ],
      },
      { content: '好的，不创建' },
    ]);
    const { stdin, lastFrame, unmount } = render(
      <App client={model} registry={registry} ctx={{ cwd: tmp }} model="deepseek-v4-flash" />,
    );
    stdin.write('创建文件');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('编辑文件');
    });
    stdin.write('n');
    await waitFor(() => {
      expect(lastFrame()).toContain('好的，不创建');
    });
    expect(() => readFileSync(path.join(tmp, 'b.txt'))).toThrow();
    unmount();
  });

  it('模型调用失败显示错误信息', async () => {
    const model = new FakeModel([{ content: 'x' }]);
    model.failNext = new Error('连接超时');
    const { stdin, lastFrame, unmount } = render(
      <App client={model} registry={registry} ctx={{ cwd: tmp }} model="deepseek-v4-flash" />,
    );
    stdin.write('hi');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('连接超时');
    });
    unmount();
  });

  it('流式结束后状态条显示真实 usage，流式中显示估算', async () => {
    const model = new FakeModel(
      [
        {
          content: '你好，Lumen',
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        },
      ],
      60,
    );
    const { stdin, lastFrame, unmount } = render(
      <App client={model} registry={registry} ctx={{ cwd: tmp }} model="deepseek-v4-flash" />,
    );
    stdin.write('你好');
    await sleep(50);
    stdin.write('\r');
    // 流式过程中（首 chunk 延迟 60ms）：状态条仍显示估算值，无「真实」标记
    await waitFor(() => {
      expect(lastFrame()).toContain('2/0');
    });
    expect(lastFrame()).not.toContain('真实');
    // 流式结束后：显示 API 返回的真实 usage
    await waitFor(() => {
      expect(lastFrame()).toContain('100/50');
    });
    expect(lastFrame()).toContain('（真实）');
    unmount();
  });

  it('Ctrl+C 中断生成：保留已生成内容并显示中断提示', async () => {
    const model = new AbortableModel();
    const { stdin, lastFrame, unmount } = render(
      <App client={model} registry={registry} ctx={{ cwd: tmp }} model="deepseek-v4-flash" />,
    );
    stdin.write('你好');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('第一段');
    });
    stdin.write('\x03'); // Ctrl+C
    await waitFor(() => {
      expect(lastFrame()).toContain('已中断');
    });
    // 已生成内容保留在会话中
    expect(lastFrame()).toContain('第一段');
    unmount();
  });
});
