/**
 * 场景提示端到端集成测试（v5.0 T13）。
 *
 * 走**真实 App**：真的发一条消息 → 流式 → idle → 断言提示出现；
 * 再验证 `/hints off` 立刻静默、流式期间不出现、冷却持久化被调用。
 *
 * 隔离纪律（AGENTS 第 16 条 + 踩坑记录教训）：
 * - `cwd` 用 tmp 目录（`hasProjectRulesFile` 只看这个目录）；
 * - 冷却读写全部注入（`readHintCooldownsForTest` / `writeHintCooldownsForTest`），
 *   绝不碰开发者真实 `~/.concertoai/hint-state.json`；
 * - `hintsEnabled` 显式传 true（`tests/setup.ts` 默认把它设成 off）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HintStateReadResult, HintStateWriteResult } from '../../src/core/suggestion';
import type { ToolCall } from '../../src/loop/types';
import type {
  ChatCompletionChunk,
  ModelClient,
  StreamChatParams,
  Usage,
} from '../../src/model/client';
import { readFileTool } from '../../src/tools/read';
import { ToolRegistry } from '../../src/tools/registry';
import { App } from '../../src/ui/App';

interface FakeReply {
  content?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
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

class FakeModel implements ModelClient {
  constructor(private readonly script: FakeReply[]) {}

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const reply = this.script.shift();
    if (reply === undefined) {
      throw new Error('FakeModel 脚本耗尽');
    }
    if (reply.content !== undefined) {
      yield fakeChunk({ content: reply.content });
    }
    let index = 0;
    for (const tc of reply.toolCalls ?? []) {
      yield fakeChunk({
        tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: tc.arguments } }],
      });
      index += 1;
    }
    yield fakeChunk({}, 'stop', reply.usage);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

let tmp: string;
let registry: ToolRegistry;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-hint-app-'));
  registry = new ToolRegistry().register(readFileTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 冷却读写桩：记录写盘调用（断言持久化真的发生），读回空。 */
function makeHintStateSpy(): {
  read: () => Promise<HintStateReadResult>;
  write: (
    cooldowns: Readonly<Record<string, number>>,
    options?: { now?: number },
  ) => Promise<HintStateWriteResult>;
  writes: Array<Record<string, number>>;
} {
  const writes: Array<Record<string, number>> = [];
  return {
    writes,
    read: async () => ({ cooldowns: {}, reset: false }),
    write: async (cooldowns) => {
      writes.push({ ...cooldowns });
      return { ok: true };
    },
  };
}

describe('T13 场景①：无规则文件 → 提示 concertoai init', () => {
  it('发一条消息 → 回复结束后，输入框上方出现 init 提示（命令完整）', async () => {
    const model = new FakeModel([{ content: '好的' }]);
    const hintState = makeHintStateSpy();
    const { stdin, lastFrame, unmount } = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        hintsEnabled
        readHintCooldownsForTest={hintState.read}
        writeHintCooldownsForTest={hintState.write}
      />,
    );
    // 首屏（userTurns=0）不该抢开场白
    expect(lastFrame()).not.toContain('concertoai init');

    stdin.write('帮我看看这个项目');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('好的');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('concertoai init');
    });
    // 冷却被持久化（fire-and-forget，给一帧时间）
    await waitFor(() => {
      expect(hintState.writes.length).toBeGreaterThan(0);
    });
    expect(hintState.writes[0]).toHaveProperty('missing-project-rules');
    unmount();
  });

  it('hintsEnabled=false（配置关）→ 全程不出现提示', async () => {
    const model = new FakeModel([{ content: '好的' }]);
    const hintState = makeHintStateSpy();
    const { stdin, lastFrame, unmount } = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        hintsEnabled={false}
        readHintCooldownsForTest={hintState.read}
        writeHintCooldownsForTest={hintState.write}
      />,
    );
    stdin.write('帮我看看这个项目');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('好的');
    });
    expect(lastFrame()).not.toContain('concertoai init');
    expect(hintState.writes).toHaveLength(0);
    unmount();
  });
});

describe('T13 约束⑤：/hints off 立刻静默，/hints on 恢复', () => {
  it('/hints off → 当前提示消失且不再出现；回执给出恢复方式', async () => {
    const model = new FakeModel([{ content: '好的' }, { content: '第二轮' }]);
    const hintState = makeHintStateSpy();
    const { stdin, lastFrame, unmount } = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        hintsEnabled
        readHintCooldownsForTest={hintState.read}
        writeHintCooldownsForTest={hintState.write}
      />,
    );
    stdin.write('第一条消息');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('concertoai init');
    });

    stdin.write('/hints off');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('/hints on');
    });
    // 提示行已经消失（回执文本里含 /hints on，但它不是提示行；用 init 命令判断）
    await waitFor(() => {
      expect(lastFrame()).not.toContain('concertoai init');
    });
    unmount();
  });

  it('/hints status 显示当前状态与真实上限数字', async () => {
    const model = new FakeModel([]);
    const hintState = makeHintStateSpy();
    const { stdin, lastFrame, unmount } = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        hintsEnabled
        readHintCooldownsForTest={hintState.read}
        writeHintCooldownsForTest={hintState.write}
      />,
    );
    stdin.write('/hints status');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('场景提示：已开启');
    });
    expect(lastFrame()).toContain('3');
    unmount();
  });

  it('/hints 未知子命令 → 回执提示用法，不吞掉输入', async () => {
    const model = new FakeModel([]);
    const hintState = makeHintStateSpy();
    const { stdin, lastFrame, unmount } = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        hintsEnabled
        readHintCooldownsForTest={hintState.read}
        writeHintCooldownsForTest={hintState.write}
      />,
    );
    stdin.write('/hints maybe');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('maybe');
    });
    unmount();
  });
});

describe('T13 约束②：流式输出期间不渲染提示', () => {
  it('流式进行中不出现提示，回到 idle 才出现', async () => {
    // 用一个「慢」模型：首 chunk 后延迟，制造可观测的 streaming 窗口
    let releaseSecond = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const slowModel: ModelClient = {
      async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
        yield fakeChunk({ content: '第一段' });
        await gate;
        yield fakeChunk({ content: '第二段' });
        yield fakeChunk({}, 'stop');
      },
    };
    const hintState = makeHintStateSpy();
    const { stdin, lastFrame, unmount } = render(
      <App
        client={slowModel}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        hintsEnabled
        readHintCooldownsForTest={hintState.read}
        writeHintCooldownsForTest={hintState.write}
      />,
    );
    stdin.write('慢请求');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('第一段');
    });
    // 流式进行中：绝不出现提示
    expect(lastFrame()).not.toContain('concertoai init');

    releaseSecond();
    await waitFor(() => {
      expect(lastFrame()).toContain('第二段');
    });
    // 流结束 → 提示出现
    await waitFor(() => {
      expect(lastFrame()).toContain('concertoai init');
    });
    unmount();
  });
});

describe('T13：冷却装载前不判定（避免启动即弹）', () => {
  it('磁盘里已有冷却记录 → 重启后同一提示不再出现', async () => {
    const model = new FakeModel([{ content: '好的' }]);
    const writes: Array<Record<string, number>> = [];
    const { stdin, lastFrame, unmount } = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        hintsEnabled
        // 磁盘里「刚刚提示过」
        readHintCooldownsForTest={async () => ({
          cooldowns: { 'missing-project-rules': Date.now() },
          reset: false,
        })}
        writeHintCooldownsForTest={async (cooldowns) => {
          writes.push({ ...cooldowns });
          return { ok: true };
        }}
      />,
    );
    stdin.write('帮我看看这个项目');
    await sleep(50);
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('好的');
    });
    // 冷却生效：即使规则命中也不出提示（这正是「重启后不重复」）
    expect(lastFrame()).not.toContain('concertoai init');
    expect(writes).toHaveLength(0);
    unmount();
  });
});
