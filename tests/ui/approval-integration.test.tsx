/**
 * 审批 UI 集成测试（v5.0 T9.4）——跑真实 `App`，验收三条最关键的行为：
 *
 * | # | 约束 | 为什么必须端到端测 |
 * |---|---|---|
 * | G1 | `y` → 批准、`n` → 拒绝，返回值语义与 v4.1.1 逐字节一致 | 改审批 UI 最容易顺手改坏安全语义 |
 * | G2 | 分析失败 / 超时 → 自动 plain，**审批仍可完成** | 「分析」绝不能挡住「按 y」 |
 * | T9.3c | `v` / `?` 走 80ms 节流，`y` / `n` **绝不**节流 | 展示态可慢一点，决议必须即时 |
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../src/i18n';
import type { ToolCall } from '../../src/loop/types';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import { editFileTool } from '../../src/tools/edit';
import { readFileTool } from '../../src/tools/read';
import { ToolRegistry } from '../../src/tools/registry';
import { App } from '../../src/ui/App';

/** 按脚本回复的假模型。 */
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-t9-'));
  registry = new ToolRegistry().register(readFileTool).register(editFileTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 造一个「AI 调用 edit_file」的 App。 */
function renderApprovalApp(options: {
  /** 第 2 轮回复（审批后的收尾文案）。 */
  finalReply: string;
  /** 编辑参数。 */
  args?: string;
  /** App 额外 props。 */
  props?: Partial<Parameters<typeof App>[0]>;
}) {
  const model = new FakeModel([
    {
      toolCalls: [
        {
          id: 'c1',
          name: 'edit_file',
          arguments: options.args ?? '{"path":"a.ts","search":"","replace":"const a = 1"}',
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
      {...options.props}
    />,
  );
}

/**
 * 触发一次审批框出现。
 *
 * 断言用「批准」而不是「审批」：测试进程的 stdout 不是 TTY，
 * T8 的降级矩阵会走 plain（标题为「编辑文件: …」），此时没有「审批」二字——
 * 这正是 G2 的预期行为，不该让触发逻辑依赖 rich 文案。
 */
async function triggerApproval(app: ReturnType<typeof renderApprovalApp>): Promise<void> {
  app.stdin.write('改一下');
  await sleep(50);
  app.stdin.write('\r');
  await waitFor(() => {
    expect(app.lastFrame()).toContain('批准');
  }, 4_000);
}

/** rich 路径需要的环境注入（测试进程默认非 TTY，会走 plain）。 */
const RICH_ENV = { insightEnv: { isTTY: true, isCI: false } } as const;

/** shell 分隔符不参与断言的窄 diff（避免输出被终端宽度折断导致 contains 误判）。 */
const SIMPLE_ARGS = '{"path":"a.ts","search":"","replace":"const a = 1"}';

describe('G1：审批语义与 v4.1.1 一致', () => {
  it('y → 批准并落盘（返回值 true 生效）', async () => {
    const app = renderApprovalApp({ finalReply: '已创建' });
    await triggerApproval(app);
    expect(() => readFileSync(path.join(tmp, 'a.ts'))).toThrow();
    app.stdin.write('y');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已创建');
    });
    expect(readFileSync(path.join(tmp, 'a.ts'), 'utf8')).toBe('const a = 1');
    app.unmount();
  });

  it('n → 拒绝不落盘（返回值 false 生效）', async () => {
    const app = renderApprovalApp({ finalReply: '好的，不改' });
    await triggerApproval(app);
    app.stdin.write('n');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('好的，不改');
    });
    expect(() => readFileSync(path.join(tmp, 'a.ts'))).toThrow();
    app.unmount();
  });

  it('Esc 等同 n（fail-closed，且不退出应用）', async () => {
    const app = renderApprovalApp({ finalReply: '已中止' });
    await triggerApproval(app);
    app.stdin.write('\u001B');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已中止');
    });
    expect(() => readFileSync(path.join(tmp, 'a.ts'))).toThrow();
    app.unmount();
  });
});

describe('G2：分析失败/降级时审批照常完成', () => {
  it('非 TTY（CI）环境 → plain 审批框，仍可 y 批准', async () => {
    const app = renderApprovalApp({
      finalReply: '已创建',
      props: { insightEnv: { isTTY: false } },
    });
    await triggerApproval(app);
    const frame = app.lastFrame() ?? '';
    // plain：v4.1.1 三行形态（无 rich 区块）
    expect(frame).toContain('批准 (y / Enter)');
    expect(frame).not.toContain('影响面');
    app.stdin.write('y');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已创建');
    });
    expect(readFileSync(path.join(tmp, 'a.ts'), 'utf8')).toBe('const a = 1');
    app.unmount();
  });

  it('config approvalInsight=plain → 强制 plain，审批仍可完成', async () => {
    const app = renderApprovalApp({
      finalReply: '已创建',
      props: { approvalInsightMode: 'plain' },
    });
    await triggerApproval(app);
    expect(app.lastFrame()).not.toContain('中风险审批');
    app.stdin.write('y');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已创建');
    });
    app.unmount();
  });

  it('分析用的 cwd 不存在 → 影响面分析失败也不阻断审批（仍能 y）', async () => {
    const app = renderApprovalApp({
      finalReply: '已创建',
      // 指向不存在的目录：impact-scan 的根目录读不了 → status='error'
      props: { ctx: { cwd: tmp }, insightEnv: { isTTY: true, isCI: false } },
    });
    await triggerApproval(app);
    app.stdin.write('y');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已创建');
    });
    app.unmount();
  });
});

describe('T9.3c：展示态节流 / 决议不节流', () => {
  it('狂按 v 10 次不会崩，且最终状态确定（最后一次意图生效）', async () => {
    // 30 行 diff：折叠态与展开态行数差异明显
    const longBody = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const app = renderApprovalApp({
      finalReply: '已创建',
      args: JSON.stringify({ path: 'a.ts', search: '', replace: longBody }),
      props: RICH_ENV,
    });
    await triggerApproval(app);
    // 洞察是**异步补齐**的：审批框先以 plain 出现（G2 永不等待分析），
    // 因此这里等 rich 卡片到位再看按键行
    await waitFor(() => {
      expect(app.lastFrame()).toContain('[v] 完整 diff');
    });
    const collapsed = app.lastFrame() ?? '';
    expect(collapsed).toContain('[y] 批准');

    for (let i = 0; i < 10; i += 1) {
      app.stdin.write('v');
    }
    await sleep(250);
    // 10 次连按 → 偶数次回到收起态（节流丢弃中间态，但最后一次意图必须落地）
    expect(app.lastFrame()).toContain('[v] 完整 diff');

    // 关键：连按之后审批决议依然可用
    app.stdin.write('y');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已创建');
    });
    app.unmount();
  });

  it('v 之后立刻按 y：决议即时生效（y 不经过 80ms 节流）', async () => {
    const app = renderApprovalApp({ finalReply: '已创建', args: SIMPLE_ARGS, props: RICH_ENV });
    await triggerApproval(app);
    app.stdin.write('v');
    app.stdin.write('y'); // 不等节流窗口
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已创建');
    }, 1_500);
    expect(readFileSync(path.join(tmp, 'a.ts'), 'utf8')).toBe('const a = 1');
    app.unmount();
  });

  it('n 在展开态下也即时生效（不落盘）', async () => {
    const app = renderApprovalApp({ finalReply: '已放弃', args: SIMPLE_ARGS, props: RICH_ENV });
    await triggerApproval(app);
    app.stdin.write('v');
    app.stdin.write('n');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已放弃');
    }, 1_500);
    expect(() => readFileSync(path.join(tmp, 'a.ts'))).toThrow();
    app.unmount();
  });

  it('? 展开说明后再按 ? 收起（状态可逆，不残留）', async () => {
    const app = renderApprovalApp({ finalReply: '已创建', args: SIMPLE_ARGS, props: RICH_ENV });
    await triggerApproval(app);
    app.stdin.write('?');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('这一屏在说什么');
    });
    await sleep(150);
    app.stdin.write('?');
    await waitFor(() => {
      expect(app.lastFrame()).not.toContain('这一屏在说什么');
    });
    app.stdin.write('n');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已创建');
    });
    app.unmount();
  });
});

describe('rich 卡片在 App 内真实出现', () => {
  it('TTY 环境 → 显示标题/操作意图/按键四件套', async () => {
    const app = renderApprovalApp({
      finalReply: '已改',
      args: '{"path":"src/api.ts","search":"","replace":"export const timeout = 10000;"}',
      props: RICH_ENV,
    });
    await triggerApproval(app);
    // 洞察是**异步补齐**的（G2：审批框先以 plain 出现，绝不等待分析），
    // 因此断言 rich 卡片必须等待，不能 immediately 读一帧就断言（会偶发读到 plain 态 → flaky）
    await waitFor(() => {
      expect(app.lastFrame()).toMatch(/风险审批 · 编辑文件 src\/api\.ts/);
    });
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('操作意图');
    expect(frame).toContain('[y] 批准');
    expect(frame).toContain('[v] 完整 diff');
    expect(frame).toContain('[?] 说明');
    app.stdin.write('y');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已改');
    });
    app.unmount();
  });

  it('medium 命中（超时改动）→ 提示「建议重点关注」且全文无「危险」', async () => {
    const app = renderApprovalApp({
      finalReply: '已改',
      args: '{"path":"src/api.ts","search":"","replace":"const timeout = 30000;"}',
      props: RICH_ENV,
    });
    await triggerApproval(app);
    // 同上：等 rich 卡片补齐后再断言（避免与异步分析赛跑）
    await waitFor(() => {
      expect(app.lastFrame()).toContain('🟡 中风险审批');
    });
    const frame = app.lastFrame() ?? '';
    // 新建文件内容含 timeout → network-timeout（medium）命中
    expect(frame).toContain('建议重点关注');
    expect(frame).not.toContain('危险');
    app.stdin.write('n');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('已改');
    });
    app.unmount();
  });
});
