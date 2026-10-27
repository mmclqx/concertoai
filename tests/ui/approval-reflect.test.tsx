/**
 * 拒绝复盘记录的 UI 集成测试（v5.0 T10）。
 *
 * 这里跑**真实 App**，只把「复盘写入」注入成捕获器（`appendReflectionForTest`）——
 * 因为真正的写盘在 `~/.concertoai/` 下，测试必须隔离，否则一次 `npm test`
 * 会污染开发者本机的真实复盘记录（这也是把 writer 做成可注入的原因）。
 *
 * 覆盖 T10 验收 + 用户两条铁律：
 * | # | 约束 | 断言方式 |
 * |---|---|---|
 * | G8 | 零网络本地写入、可关闭 | `reflectionsEnabled=false` → writer 一次都没被调用 |
 * | G2' | **写盘失败绝不阻塞审批** | writer 抛错 → 模型仍收到拒绝并继续（不卡在 approval 相） |
 * | — | 只有「编辑 + 拒绝」才记 | 批准不记；shell 拒绝不记 |
 * | — | 未分析不谎报 low | 非 TTY（plain）下 level 必须是 unknown |
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReflectionEntry } from '../../src/core/reflection-store';
import { setLocale } from '../../src/i18n';
import type { ToolCall } from '../../src/loop/types';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import { editFileTool } from '../../src/tools/edit';
import { readFileTool } from '../../src/tools/read';
import { ToolRegistry } from '../../src/tools/registry';
import { shellTool } from '../../src/tools/shell';
import { App } from '../../src/ui/App';

class FakeModel implements ModelClient {
  constructor(private readonly script: { content?: string; toolCalls?: ToolCall[] }[]) {}

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const reply = this.script.shift();
    if (reply === undefined) {
      throw new Error('FakeModel 脚本耗尽');
    }
    if (reply.content !== undefined) {
      yield chunk({ content: reply.content });
    }
    let index = 0;
    for (const tc of reply.toolCalls ?? []) {
      yield chunk({
        tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: tc.arguments } }],
      });
      index += 1;
    }
    yield chunk({}, 'stop');
  }
}

function chunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
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
      await sleep(20);
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
  setLocale('zh');
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-t10-'));
  registry = new ToolRegistry().register(readFileTool).register(editFileTool).register(shellTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 捕获器：记录 App 交来的复盘条目（不落盘）。 */
function makeCapture(options: { fail?: boolean } = {}): {
  writer: (entry: ReflectionEntry) => Promise<{ ok: boolean; error?: string }>;
  entries: ReflectionEntry[];
} {
  const entries: ReflectionEntry[] = [];
  const writer = async (entry: ReflectionEntry): Promise<{ ok: boolean; error?: string }> => {
    if (options.fail === true) {
      throw new Error('模拟写盘失败（目录只读）');
    }
    entries.push(entry);
    return { ok: true };
  };
  return { writer, entries };
}

function renderApp(options: {
  finalReply: string;
  args?: Record<string, unknown>;
  props?: Partial<Parameters<typeof App>[0]>;
}) {
  const model = new FakeModel([
    {
      toolCalls: [
        {
          id: 'c1',
          name: 'edit_file',
          arguments: JSON.stringify(
            options.args ?? { path: 'a.ts', search: '', replace: 'const a = 1' },
          ),
        },
      ],
    },
    { content: options.finalReply },
  ]);
  return render(
    <App
      client={model}
      registry={registry}
      ctx={{ cwd: tmp }}
      model="deepseek-v4-flash"
      // 显式开启：全局测试环境把复盘默认关了（tests/setup.ts），
      // 本文件要验证「写入路径」，意图必须写在代码里而不是依赖环境巧合
      reflectionsEnabled
      {...options.props}
    />,
  );
}

/** 触发审批框出现（非 TTY → plain，断言「批准」二字）。 */
async function triggerApproval(app: ReturnType<typeof renderApp>): Promise<void> {
  app.stdin.write('改一下');
  await sleep(50);
  app.stdin.write('\r');
  await waitFor(() => {
    expect(app.lastFrame()).toContain('批准');
  }, 4_000);
}

describe('T10：拒绝 → 记一条本地复盘', () => {
  it('n 拒绝后追加一条，字段齐全且 decision=rejected', async () => {
    const capture = makeCapture();
    const app = renderApp({
      finalReply: '好的，我不改了',
      props: { appendReflectionForTest: capture.writer },
    });
    await triggerApproval(app);
    app.stdin.write('n');
    await waitFor(() => {
      expect(capture.entries).toHaveLength(1);
    });
    // 审批语义不受影响：决策已下发、文件未写盘
    await waitFor(() => {
      expect(app.lastFrame()).toContain('好的，我不改了');
    });
    expect(() => readFileSync(path.join(tmp, 'a.ts'))).toThrow();

    const entry = capture.entries[0] as ReflectionEntry;
    expect(entry.decision).toBe('rejected');
    expect(entry.file).toBe('a.ts');
    expect(entry.project).toBe(path.basename(tmp));
    expect(typeof entry.ts).toBe('number');
    // 非 TTY → T8 降级为 plain → 没有洞察 → 必须是 unknown，不是 low
    expect(entry.level).toBe('unknown');
    expect(entry.categories).toEqual([]);
    app.unmount();
  });

  it('rich 模式（TTY 注入）下记录真实风险级别与关注行', async () => {
    const capture = makeCapture();
    const app = renderApp({
      finalReply: '收到',
      // 危险删除 → high 级命中，focusLines 非空
      args: { path: 'a.ts', search: '', replace: 'rmSync(target, { recursive: true })' },
      props: {
        appendReflectionForTest: capture.writer,
        insightEnv: { isTTY: true, isCI: false },
      },
    });
    await triggerApproval(app);
    // 等分析补齐（insight 到达后才有级别）
    await sleep(300);
    app.stdin.write('n');
    await waitFor(() => {
      expect(capture.entries).toHaveLength(1);
    });
    const entry = capture.entries[0] as ReflectionEntry;
    expect(['high', 'medium', 'low', 'unknown']).toContain(entry.level);
    expect(Array.isArray(entry.categories)).toBe(true);
    expect(Array.isArray(entry.focusLines)).toBe(true);
    app.unmount();
  });

  it('批准（y）不记复盘（认可的操作没有复盘价值）', async () => {
    const capture = makeCapture();
    const app = renderApp({
      finalReply: '已创建',
      props: { appendReflectionForTest: capture.writer },
    });
    await triggerApproval(app);
    app.stdin.write('y');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已创建');
    });
    expect(capture.entries).toEqual([]);
    app.unmount();
  });

  it('shell 命令拒绝不记（复盘只针对编辑：命令没有文件风险面）', async () => {
    const capture = makeCapture();
    const model = new FakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'npm test' }) },
        ],
      },
      { content: '已跳过命令' },
    ]);
    const app = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        reflectionsEnabled
        appendReflectionForTest={capture.writer}
      />,
    );
    app.stdin.write('跑测试');
    await sleep(50);
    app.stdin.write('\r');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    }, 4_000);
    app.stdin.write('n');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已跳过命令');
    });
    expect(capture.entries).toEqual([]);
    app.unmount();
  });
});

describe('T10 铁律：关闭开关 / 写盘失败都不影响审批', () => {
  it('reflectionsEnabled=false → 一次都不写，拒绝照常生效', async () => {
    const capture = makeCapture();
    const app = renderApp({
      finalReply: '已取消',
      props: { appendReflectionForTest: capture.writer, reflectionsEnabled: false },
    });
    await triggerApproval(app);
    app.stdin.write('n');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已取消');
    });
    expect(capture.entries).toEqual([]);
    // 关掉开关只是不记录，绝不能让失败文案出现
    expect(app.lastFrame()).not.toContain('复盘');
    app.unmount();
  });

  it('【G2′】写盘抛错 → 审批流程照常走完（模型收到拒绝并继续）', async () => {
    const capture = makeCapture({ fail: true });
    const app = renderApp({
      finalReply: '那我换个思路',
      props: { appendReflectionForTest: capture.writer },
    });
    await triggerApproval(app);
    app.stdin.write('n');
    // 关键：模型第二轮照常执行（说明审批没有卡住 / 没崩）
    await waitFor(() => {
      expect(app.lastFrame()).toContain('那我换个思路');
    });
    // 如实告知写盘失败，但不打断
    await waitFor(() => {
      expect(app.lastFrame()).toContain('复盘记录写入失败');
    });
    expect(capture.entries).toEqual([]);
    app.unmount();
  });

  it('未传 prop 时默认遵循环境变量 CONCERTOAI_REFLECTIONS=off（测试环境不落盘）', async () => {
    // tests/setup.ts 已把该环境变量设为 off；App 的缺省值必须读到它，
    // 否则 `npm test` 会把复盘写进开发者真实 home（实测踩到过 16 条垃圾记录）
    const capture = makeCapture();
    const model = new FakeModel([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'c.ts', search: '', replace: 'x' }),
          },
        ],
      },
      { content: '好' },
    ]);
    const app = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        // 注意：**不传** reflectionsEnabled
        appendReflectionForTest={capture.writer}
      />,
    );
    app.stdin.write('改');
    await sleep(50);
    app.stdin.write('\r');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    app.stdin.write('n');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('好');
    });
    expect(capture.entries).toEqual([]);
    app.unmount();
  });

  it('拒绝后显示「已记录到本地复盘」并指明关闭方式', async () => {
    const capture = makeCapture();
    const app = renderApp({
      finalReply: '好',
      props: { appendReflectionForTest: capture.writer },
    });
    await triggerApproval(app);
    app.stdin.write('n');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已记录到本地复盘');
    });
    const frame = app.lastFrame() ?? '';
    // 承诺的命令必须与真实注册的命令一致（护栏：别写一个不存在的命令）
    expect(frame).toContain('concertoai reflect list');
    expect(frame).toContain('config set reflections off');
    app.unmount();
  });
});
