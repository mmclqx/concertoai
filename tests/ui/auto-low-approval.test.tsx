/**
 * `--auto-low` 的**审批集成**测试（v5.1 T1.3，判据 C3）。
 *
 * 跑真组件（`ink-testing-library` + 真 `analyzeApproval`）+ 真 `edit_file` 工具，
 * 断言的是「这一次编辑到底弹不弹框」这一件用户能看见的事。
 *
 * ## 6 条安全边界（逐条都能被对应变异探针打穿）
 *
 * | # | 场景 | 期望 | 对应探针 |
 * |---|---|---|---|
 * | 1 | 不加 `--auto-low` + 零命中编辑 | 弹框（默认行为不变） | — |
 * | 2 | 加 `--auto-low` + 零命中编辑 | **不弹框** + 留痕 | M5（删留痕 ⇒ 红） |
 * | 3 | 加 `--auto-low` + `rm -rf` 编辑 | 弹框（high） | M3（恒 allow ⇒ 红） |
 * | 4 | 加 `--auto-low` + 空 catch / lock 编辑 | 弹框（medium） | M3 |
 * | 5 | 加 `--auto-low` + 非 TTY | 弹框（degraded） | **M1（删 degraded 判断 ⇒ 红）** |
 * | 6 | 加 `--auto-low` + shell 命令 | 弹框（shell 永不纳入） | M2（删 kind 判断 ⇒ 红） |
 *
 * ## 为什么第 5 条是命门
 *
 * 非 TTY 时 `analyzeApproval` 走降级，`hits=[]` ⇒ `levelOf([])` = `'low'`。
 * 只判 level 的实现会在这里放行 —— 也就是「CI 里所有编辑都不问」，等于 yolo。
 * 本文件刻意让 5 与 2 使用**同一段 diff**，唯一差别是 TTY 环境：
 * 这样「只判 level」的废实现必然同时通过 2、红在 5，探针结论无从含糊。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function waitFor(assert: () => void, timeoutMs = 4_000): Promise<void> {
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-v51-'));
  registry = new ToolRegistry().register(readFileTool).register(editFileTool).register(shellTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 零命中编辑：新建一个纯常量文件（15 条规则一条都不命中）。 */
const CLEAN_ARGS = JSON.stringify({ path: 'clean.ts', search: '', replace: 'const a = 1' });
/** high：新增一行 rm -rf（dangerous-delete）。 */
const HIGH_ARGS = JSON.stringify({
  path: 'danger.ts',
  search: '',
  replace: 'run("rm -rf /tmp/x")',
});
/** medium：空 catch（silent-catch）。 */
const MEDIUM_SILENT_ARGS = JSON.stringify({
  path: 'silent.ts',
  search: '',
  replace: 'try { a(); } catch {}',
});
/** medium：并发锁（concurrency）。 */
const MEDIUM_LOCK_ARGS = JSON.stringify({
  path: 'lock.ts',
  search: '',
  replace: 'const lock = new Mutex();',
});

/** TTY 环境（rich 与「不降级」都需要它）。 */
const TTY = { insightEnv: { isTTY: true, isCI: false } } as const;
/** 非 TTY 环境（走 non-tty 降级）。 */
const NON_TTY = { insightEnv: { isTTY: false, isCI: false } } as const;

function renderApp(options: { args: string; props?: Partial<Parameters<typeof App>[0]> }) {
  const model = new FakeModel([
    { toolCalls: [{ id: 'c1', name: 'edit_file', arguments: options.args }] },
    { content: '完成了' },
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

/** 发出一次需求（等模型回复 + 工具执行）。 */
async function sendTask(app: ReturnType<typeof renderApp>): Promise<void> {
  app.stdin.write('改一下');
  await sleep(50);
  app.stdin.write('\r');
}

/** 等最终回复出现（= 流程跑完，无论中途有没有弹框）。 */
async function waitDone(app: ReturnType<typeof renderApp>): Promise<void> {
  await waitFor(() => {
    expect(app.lastFrame()).toContain('完成了');
  });
}

describe('用例 1：不加 --auto-low ⇒ 默认行为不变（仍弹框）', () => {
  it('零命中编辑也要问（autoLow 缺省 false）', async () => {
    const app = renderApp({ args: CLEAN_ARGS, props: TTY });
    await sendTask(app);
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    expect(existsSync(path.join(tmp, 'clean.ts'))).toBe(false);
    app.stdin.write('y');
    await waitDone(app);
    app.unmount();
  });
});

describe('用例 2：加 --auto-low + 零命中 ⇒ 不弹框 + 留痕', () => {
  it('直接落盘（没出现审批框），且留痕含次数与摘要', async () => {
    const app = renderApp({ args: CLEAN_ARGS, props: { ...TTY, autoLow: true } });
    await sendTask(app);
    await waitDone(app);

    // ① 不弹框：全程没有出现过审批提示
    //    （lastFrame 是终态，因此用「文件已落盘 + 没卡在审批」两条一起判）
    expect(readFileSync(path.join(tmp, 'clean.ts'), 'utf8')).toBe('const a = 1');
    // ② 留痕：不问就必须让用户看见
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('已自动放行');
    expect(frame).toContain('clean.ts');
    // ③ 文案不撒谎：low ≠ 安全
    expect(frame).not.toContain('安全');
    app.unmount();
  });

  it('留痕带累计次数（多次放行时数字会涨）', async () => {
    const model = new FakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'edit_file', arguments: CLEAN_ARGS },
          {
            id: 'c2',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'clean2.ts', search: '', replace: 'const b = 2' }),
          },
        ],
      },
      { content: '完成了' },
    ]);
    const app = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        {...TTY}
        autoLow
      />,
    );
    await sendTask(app);
    await waitDone(app);
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('已自动放行 2 次');
    expect(existsSync(path.join(tmp, 'clean.ts'))).toBe(true);
    expect(existsSync(path.join(tmp, 'clean2.ts'))).toBe(true);
    app.unmount();
  });
});

describe('用例 3：high（rm -rf）⇒ 仍弹框', () => {
  it('dangerous-delete 命中 ⇒ 必须等人确认', async () => {
    const app = renderApp({ args: HIGH_ARGS, props: { ...TTY, autoLow: true } });
    await sendTask(app);
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    expect(existsSync(path.join(tmp, 'danger.ts'))).toBe(false);
    app.stdin.write('n');
    await waitDone(app);
    expect(existsSync(path.join(tmp, 'danger.ts'))).toBe(false);
    app.unmount();
  });
});

describe('用例 4：medium ⇒ 仍弹框（5.1 刻意不放）', () => {
  it('空 catch（silent-catch）⇒ 弹框', async () => {
    const app = renderApp({ args: MEDIUM_SILENT_ARGS, props: { ...TTY, autoLow: true } });
    await sendTask(app);
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    app.stdin.write('n');
    await waitDone(app);
    app.unmount();
  });

  it('并发锁（concurrency）⇒ 弹框', async () => {
    const app = renderApp({ args: MEDIUM_LOCK_ARGS, props: { ...TTY, autoLow: true } });
    await sendTask(app);
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    app.stdin.write('n');
    await waitDone(app);
    app.unmount();
  });
});

describe('用例 5：**安全命门**——非 TTY（降级）⇒ 仍弹框（配 M1 探针）', () => {
  /**
   * 与用例 2 用**完全相同的参数**（CLEAN_ARGS），唯一差别是 isTTY。
   *
   * 只判 `level === 'low'` 的实现会在这里放行（降级时 level 恰好是 low）⇒ 本用例红。
   * 这就是 M1 探针的靶子：删掉 `degraded !== false` 判断，用例 2 仍绿、用例 5 必红。
   */
  it('非 TTY + 零命中 ⇒ 仍弹框（降级不放行）', async () => {
    const app = renderApp({ args: CLEAN_ARGS, props: { ...NON_TTY, autoLow: true } });
    await sendTask(app);
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    expect(existsSync(path.join(tmp, 'clean.ts'))).toBe(false);
    app.stdin.write('n');
    await waitDone(app);
    app.unmount();
  });

  it('CI + 零命中 ⇒ 仍弹框（ci 降级同样不放行）', async () => {
    const app = renderApp({
      args: CLEAN_ARGS,
      props: { insightEnv: { isTTY: true, isCI: true }, autoLow: true },
    });
    await sendTask(app);
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    app.stdin.write('n');
    await waitDone(app);
    app.unmount();
  });
});

describe('用例 6：shell 永不纳入自动放行（走 allowlist）', () => {
  it('零命中命令（echo）也要问 —— 规则表对命令行覆盖不足', async () => {
    /**
     * 用真 shell 工具：`echo hi` 在规则表下零命中（实测 21 条危险命令里 18 条零命中，
     * 含 npm publish / git push --force），若 auto-low 覆盖 shell 就会自动执行。
     * 这里断言「仍然弹框」——即 M2 探针（删 kind 判断）的靶子。
     */
    const model = new FakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'echo hi' }) },
        ],
      },
      { content: '完成了' },
    ]);
    const app = render(
      <App
        client={model}
        registry={registry}
        ctx={{ cwd: tmp }}
        model="deepseek-v4-flash"
        {...TTY}
        autoLow
      />,
    );
    await sendTask(app);
    await waitFor(() => {
      expect(app.lastFrame()).toContain('批准');
    });
    app.stdin.write('n');
    await waitDone(app);
    app.unmount();
  });
});

describe('与既有 allowlist-only 策略互不覆盖', () => {
  it('allowlist-only + auto-low ⇒ 仍按 allowlist-only 一律拒绝（不弹框、不放行）', async () => {
    const app = renderApp({
      args: CLEAN_ARGS,
      props: { ...TTY, autoLow: true, approvalStrategy: 'allowlist-only' },
    });
    await sendTask(app);
    // allowlist-only 的语义是「不弹框，直接拒绝」：文件不该落盘，也不该出现审批框
    await waitDone(app);
    expect(existsSync(path.join(tmp, 'clean.ts'))).toBe(false);
    app.unmount();
  });
});
