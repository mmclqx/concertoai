/**
 * 「第 N 步」状态行测试（v5.1 T2.2，判据 C5 后半）。
 *
 * ## 守的是什么
 *
 * 1. 有步号 ⇒ 「第 1 步 · 执行工具: x」，且**依次**涨（1 → 2 → 3，不是恒 1）；
 * 2. **不许出现 `/总数`** —— loop 事先不知道步数，硬造分母就是骗用户（断言渲染文本无 `/\d`）；
 * 3. 新一轮输入 ⇒ 步号回到 1（不是接着上一轮的往后数）；
 * 4. 没有步号（`activeStep === 0`）⇒ 退回旧文案，**不许显示「第 0 步」**；
 * 5. 工具结束 ⇒ 状态行消失（不留残影）。
 *
 * ## 为什么用「慢工具 + 全部历史帧」
 *
 * `frames` 记录每一次渲染（含 Spinner 动画帧）。工具刻意 sleep 80ms，步 1/2/3 各自
 * 都有可观测窗口；若只看 `lastFrame()`，中间两步会一闪而过，断言只能证明「最后一步对」。
 * 顺序断言用「第一次出现该步号的帧索引」递增来表达，比「某帧里同时含三个」更贴近
 * 用户实际看到的时间顺序。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { setLocale } from '../../src/i18n';
import type { ToolCall } from '../../src/loop/types';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import type { ToolResult, ToolSpec } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';
import { App } from '../../src/ui/App';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 按脚本逐轮回包的假模型（每轮 shift 一条；耗尽即抛，避免用例静默通过）。 */
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

/**
 * 慢工具：`parallelSafe` 决定是否与相邻调用聚成并行组。
 *
 * 慢是刻意的——UI 的步号只在「执行中」渲染，执行太快就抓不到中间帧。
 */
function slowTool(name: string, parallelSafe: boolean, ms = 80): ToolSpec {
  return {
    name,
    description: name,
    parameters: z.object({}),
    parallelSafe,
    execute: async (): Promise<ToolResult> => {
      await sleep(ms);
      return { ok: true, data: name };
    },
  };
}

const call = (id: string, name: string): ToolCall => ({ id, name, arguments: '{}' });

async function waitFor(assert: () => void, timeoutMs = 6_000): Promise<void> {
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

beforeEach(() => {
  setLocale('zh');
});

afterEach(() => {
  // 本项目其它用例可能切语言（进程级状态），复位成本轮口径（AGENTS 进程级状态隔离条）
  setLocale('zh');
});

function makeApp(script: { content?: string; toolCalls?: ToolCall[] }[], registry: ToolRegistry) {
  return render(
    <App
      client={new FakeModel(script)}
      registry={registry}
      ctx={{ cwd: process.cwd() }}
      model="deepseek-v4-flash"
    />,
  );
}

async function sendTask(app: ReturnType<typeof makeApp>, text: string): Promise<void> {
  app.stdin.write(text);
  await sleep(30);
  app.stdin.write('\r');
}

describe('第 N 步：依次递增', () => {
  it('三轮各 1 个工具 ⇒ 帧里依次出现「第 1 步」「第 2 步」「第 3 步」，且顺序递增', async () => {
    const registry = new ToolRegistry()
      .register(slowTool('slow_a', false))
      .register(slowTool('slow_b', false))
      .register(slowTool('slow_c', false));
    const app = makeApp(
      [
        { toolCalls: [call('c1', 'slow_a')] },
        { toolCalls: [call('c2', 'slow_b')] },
        { toolCalls: [call('c3', 'slow_c')] },
        { content: '完成了' },
      ],
      registry,
    );

    await sendTask(app, '干活');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('完成了');
    });

    const frames = app.frames;
    const firstIndex = (needle: string): number => frames.findIndex((f) => f.includes(needle));
    // ① 三步都真的被渲染过（不是只渲染最后一步）
    expect(firstIndex('第 1 步')).toBeGreaterThanOrEqual(0);
    expect(firstIndex('第 2 步')).toBeGreaterThanOrEqual(0);
    expect(firstIndex('第 3 步')).toBeGreaterThanOrEqual(0);
    // ② 时间顺序正确：1 早于 2 早于 3（恒 1 的废实现会让 2/3 永远找不到）
    expect(firstIndex('第 1 步')).toBeLessThan(firstIndex('第 2 步'));
    expect(firstIndex('第 2 步')).toBeLessThan(firstIndex('第 3 步'));
    // ③ 状态行同时带着工具名（内层复用 ui.toolRunning）
    expect(frames[firstIndex('第 1 步')]).toContain('slow_a');
    app.unmount();
  });

  it('并行组内两个工具同时发 ⇒ 按数组顺序编号到第 2 步（不是两个都叫第 1 步）', async () => {
    const registry = new ToolRegistry()
      .register(slowTool('par_a', true))
      .register(slowTool('par_b', true));
    const app = makeApp(
      [{ toolCalls: [call('c1', 'par_a'), call('c2', 'par_b')] }, { content: '完成了' }],
      registry,
    );

    await sendTask(app, '干活');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('完成了');
    });

    const joined = app.frames.join('\n');
    expect(joined).toContain('第 2 步');
    expect(joined).toContain('par_b');
    app.unmount();
  });
});

describe('契约：不许有分母、不许有第 0 步', () => {
  it('所有渲染帧都不含「/数字」（防止有人加回 [N/total]）', async () => {
    const registry = new ToolRegistry()
      .register(slowTool('slow_a', false))
      .register(slowTool('slow_b', false));
    const app = makeApp(
      [
        { toolCalls: [call('c1', 'slow_a')] },
        { toolCalls: [call('c2', 'slow_b')] },
        { content: '完成了' },
      ],
      registry,
    );

    await sendTask(app, '干活');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('完成了');
    });

    const stepFrames = app.frames.filter((f) => f.includes('步'));
    // 正例自证：确实找到了带步号的帧，否则下面的「不含」是空转
    expect(stepFrames.length).toBeGreaterThan(0);
    /**
     * 只检查**状态行**，不检查整帧。
     *
     * 为什么：状态条合法地含 `token: 2/0`（用量统计），整帧匹配会误伤它——
     * 这条断言初版正是这么红的，改窄之前先看清是谁在说话。分母只会加在「第 N/M 步」上，
     * 所以靶子就是含「执行工具」的那一行。
     */
    const hasDenominator = (line: string): boolean => /\/\s*\d/.test(line);
    const stepLines = stepFrames.flatMap((f) =>
      f.split('\n').filter((line) => line.includes('执行工具')),
    );
    // 正例自证之二：真的取到了状态行
    expect(stepLines.length).toBeGreaterThan(0);
    for (const line of stepLines) {
      expect(hasDenominator(line)).toBe(false);
    }
    // 双向验收：同一条判据对「加回分母」的形态必须报警（过滤没放宽到失明）
    expect(hasDenominator(' ⠋ 第 3/10 步 · 执行工具: x')).toBe(true);
    app.unmount();
  });

  it('纯文本回复（无工具）⇒ 全程没有状态行（**步号判定另在纯函数单测上锁**）', async () => {
    const registry = new ToolRegistry().register(slowTool('slow_a', false));
    // 纯文本回复：全程没有任何工具事件 ⇒ activeTool 恒为 null，状态行不渲染
    const app = makeApp([{ content: '完成了' }], registry);
    await sendTask(app, '干活');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('完成了');
    });
    /**
     * 这条只守「无工具时没有状态行」。
     *
     * 首版这里写的是「不出现『第 0 步』」，配上把 `step > 0` 改成 `step >= 0` 的探针实测
     * **无牙**——因为 `activeTool` 全是 null，状态行压根不渲染，那句话永远不会被违反。
     * 「第 0 步」的判定现已搬到 `toolStepLabel` 纯函数，由
     * `tests/ui/tool-step-label.test.ts` 直接喂 `step = 0` 上锁（那条配 P3′ 探针有牙）。
     */
    const joined = app.frames.join('\n');
    expect(joined).not.toContain('执行工具');
    expect(joined).not.toContain('步');
    app.unmount();
  });
});

describe('源码护栏：直设 activeTool 的路径必须配 setActiveStep(0)（防假步号）', () => {
  /**
   * 守的是实测抓到的一个真 bug：
   *
   * `/skill`、`/self-heal`（含 onPhase 阶段更新）**不走主循环**，直接
   * `setActiveTool({...})`。它们原来没有重置 `activeStep` ⇒ 若用户上一轮跑过 3 个工具，
   * 接着敲 `/self-heal`，状态行会显示「**第 3 步** · 执行工具: self-heal」——那个 3 是
   * 上一轮的残留，属于「文案撒谎」，比不显示更糟。
   *
   * ## 为什么用源码扫描而不是造 UI 场景
   *
   * 造 `/skill` / `/self-heal` 的完整 UI 场景要塞 skillLoader、spawner、self-heal 依赖，
   * 成本高且脆。而漏配这件事的判据本身就是「源码形态」：**每个直设点后面都得有重置**。
   * 按 AGENTS 判定类护栏三条验：① 该红必红（负例样本 ⇒ false）；② 不该红必不红（真实
   * App.tsx ⇒ 全绿）；③ 过滤没放宽到失明（合法例外为 true、紧邻的真违规仍为 false）。
   */
  const hasCompanionReset = (snippet: string): boolean =>
    // 直设点之后紧邻的窗口内必须有 setActiveStep(0)（渲染出的两行间距远小于 200 字符）
    snippet.includes('setActiveStep(0)');

  it('真实 src/ui/App.tsx：每个 `setActiveTool({` 直设点后面都跟了 setActiveStep(0)', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/ui/App.tsx'), 'utf8');
    const markers = [...source.matchAll(/setActiveTool\(\{/g)].map((m) => m.index ?? 0);
    // 正例自证：确实找到了直设点，否则下面的「全部合规」是空转
    expect(markers.length).toBeGreaterThan(0);
    const unguarded = markers
      .filter((idx) => !hasCompanionReset(source.slice(idx, idx + 300)))
      .map((idx) => source.slice(idx, idx + 80).split('\n')[0]);
    expect(unguarded).toEqual([]);
  });

  it('护栏自身有牙：不带重置的样本 ⇒ false；带了 ⇒ true（含合法例外不算违规）', () => {
    const bad = "setActiveTool({ id: 'self-heal', name: 'self-heal', arguments: '{}' });\n";
    const good =
      "setActiveTool({ id: 'self-heal', name: 'self-heal', arguments: '{}' });\nsetActiveStep(0);\n";
    expect(hasCompanionReset(bad)).toBe(false);
    expect(hasCompanionReset(good)).toBe(true);
  });
});

describe('新一轮输入 ⇒ 步号从 1 重新开始', () => {
  it('第二次发送任务后出现「第 1 步 · 执行工具: slow_b」（不是第 4 步）', async () => {
    const registry = new ToolRegistry()
      .register(slowTool('slow_a', false))
      .register(slowTool('slow_b', false));
    const app = makeApp(
      [
        // 第一轮：连发 3 个工具 ⇒ 步号 1,2,3
        {
          toolCalls: [call('c1', 'slow_a'), call('c2', 'slow_b'), call('c3', 'slow_a')],
        },
        { content: '第一轮完成' },
        // 第二轮：1 个工具 ⇒ 必须又回到第 1 步
        { toolCalls: [call('c4', 'slow_b')] },
        { content: '第二轮完成' },
      ],
      registry,
    );

    await sendTask(app, '第一件事');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('第一轮完成');
    });
    const framesAfterFirst = app.frames.length;

    await sendTask(app, '第二件事');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('第二轮完成');
    });

    // 只看第二轮产生的帧：必须出现「第 1 步 ... slow_b」，且从未出现「第 4 步」
    const secondRound = app.frames.slice(framesAfterFirst);
    expect(secondRound.some((f) => f.includes('第 1 步') && f.includes('slow_b'))).toBe(true);
    expect(app.frames.join('\n')).not.toContain('第 4 步');
    app.unmount();
  });
});

describe('工具结束 ⇒ 状态行消失（不留残影）', () => {
  it('全部工具跑完后最终帧不含「执行工具」', async () => {
    const registry = new ToolRegistry().register(slowTool('slow_a', false));
    const app = makeApp([{ toolCalls: [call('c1', 'slow_a')] }, { content: '完成了' }], registry);

    await sendTask(app, '干活');
    await waitFor(() => {
      expect(app.lastFrame()).toContain('完成了');
    });
    const frame = app.lastFrame() ?? '';
    expect(frame).not.toContain('执行工具');
    expect(frame).not.toContain('第 1 步');
    app.unmount();
  });
});
