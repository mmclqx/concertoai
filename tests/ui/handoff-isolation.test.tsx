/**
 * 交接单「不许写进开发者真实 home」的护栏（v5.3 A，2026-11-14 实测缺陷）。
 *
 * ## 护的是什么：不是格式，是**可信度**
 *
 * v5.3 N4 的全部价值是一句话——「退出时留下的那份交接单说的是真的」。2026-11-14 实测发现
 * 它当场就不真了：`tests/ui/tool-step.test.tsx` 渲染**真 `App`**、`ctx={{ cwd: process.cwd() }}`
 * （= 仓库根）、家目录没钉 ⇒ 每跑一次 `npm test` 就把**开发者本机真实的那份 `handoff.md`**
 * 覆盖成「正常收尾 / 会话: 无 / 最后一条助手结论：完成了」。
 *
 * 危害不是脏文件，而是**证据被擦掉**：当晚真会话（撞 50 轮上限）在 16:05 写过交接单，
 * 16:23 被测试覆盖（sha `2bba7537…` → `213aa447…`）。用户问「刚才不知为何又退出了」时，
 * 唯一那份记录已经是假的 —— 于是「查不出来」被归因成「本来就没有记录」。
 *
 * 这个坑的形状是老问题：`tests/setup.ts` 里 `CONCERTOAI_REFLECTIONS` / `CONCERTOAI_HINTS` /
 * `CONCERTOAI_METRICS` 三个开关就是前三次「测试写到真实 home」的教训。N4 新增了第四个写盘点
 * （`~/.concertoai/handoffs/`）却没有对应的隔离手段 ⇒ 同一个坑第四次。所以第 ③ 条是**静态**
 * 护栏：它不验某一次写入，它验「档案级形状」，免得下一个人再犯。
 *
 * ## 三个用例各守一段，缺一即空转
 *
 * ① **探针通电**：真 App 真的会写交接单，且钉家目录**真的**改变落点。
 *    没有这一条，「② 真实文件没变」可以因为「压根没写」而恒真。
 * ② **否定面**：渲染一轮之后，真实 home 里本项目那份 `handoff.md` 的字节 sha 一字未变。
 * ③ **静态护栏**：任何把 `cwd` 指向仓库根的 UI 用例，必须同时钉家目录。
 *
 * ## 变异探针（已实测，证明 ①②③ 有牙）
 *
 * M1：把 `tool-step.test.tsx` 的 `ctx={{ cwd: tmpCwd }}` 改回 `process.cwd()` 并删掉
 *     `pinHome(tmpHome)` ⇒ 本文件 ② 红（sha 变了）、③ 红（静态判据命中该文件）。
 * M2：把 `pinHome` 改成只设 `USERPROFILE`、POSIX 侧不设 ⇒ Windows 上仍绿——这正是
 *     「我的环境没踩到」的反面教材，故 `pinHome` 两侧都设（注释里写明原因）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { handoffPath, resetHandoffState } from '../../src/cli/handoff';
import { setLocale } from '../../src/i18n';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import type { ToolResult, ToolSpec } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';
import { App } from '../../src/ui/App';

const REPO = process.cwd();

/**
 * **模块加载期**算出的落点 = 真实 home 下的落点（此刻本文件还没钉家目录）。
 * 必须在模块作用域算：一进 `beforeEach`，`os.homedir()` 已经是临时目录了。
 */
const REAL_PROJECT_HANDOFF = handoffPath(REPO);

const shaOf = (file: string): string =>
  existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent';

const REAL_HOME_ENV = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

let tmpHome: string;

function pinHome(dir: string): void {
  // Windows 用 USERPROFILE、POSIX 用 HOME：两侧都设。只设当前平台的话，
  // 换个平台跑就静默失效（「我这儿全绿」证明不了别人机器）。
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
}

function restoreHome(): void {
  if (REAL_HOME_ENV.USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = REAL_HOME_ENV.USERPROFILE;
  }
  if (REAL_HOME_ENV.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = REAL_HOME_ENV.HOME;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(assert: () => void, timeoutMs = 8_000): Promise<void> {
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

/** 最小假模型：一轮工具调用 + 一轮收尾，让 App 走到「写交接单」那一行。 */
class OneToolModel implements ModelClient {
  private turn = 0;

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const chunk = (
      delta: ChatCompletionChunk['choices'][number]['delta'],
      finishReason: string | null = null,
    ): ChatCompletionChunk => ({
      id: 'fake',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fake',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: null,
    });
    this.turn += 1;
    if (this.turn === 1) {
      yield chunk({
        tool_calls: [{ index: 0, id: 'c1', function: { name: 'probe_tool', arguments: '{}' } }],
      });
      yield chunk({}, 'stop');
      return;
    }
    if (this.turn === 2) {
      yield chunk({ content: '护栏用收尾语' });
      yield chunk({}, 'stop');
      return;
    }
    throw new Error('OneToolModel 脚本耗尽');
  }
}

function makeRegistry(): ToolRegistry {
  const tool: ToolSpec = {
    name: 'probe_tool',
    description: 'probe_tool',
    parameters: z.object({}),
    parallelSafe: false,
    execute: async (): Promise<ToolResult> => ({ ok: true, data: 'ok' }),
  };
  return new ToolRegistry().register(tool);
}

/**
 * 用**真 App** + `cwd` 指向仓库根渲染一轮（= 复刻那条缺陷的形状）。
 * 刻意不写成「直接调 `finalizeSession`」：缺陷出在接线层（`ctx.cwd` 由调用方给），
 * 只测纯函数测不出这个形状。
 */
async function renderOneRound(): Promise<void> {
  const app = render(
    <App
      client={new OneToolModel()}
      registry={makeRegistry()}
      ctx={{ cwd: REPO }}
      model="deepseek-v4-flash"
    />,
  );
  app.stdin.write('跑一下');
  await sleep(30);
  app.stdin.write('\r');
  try {
    await waitFor(() => {
      if (!existsSync(handoffPath(REPO))) {
        throw new Error('交接单还没写出来');
      }
    });
  } finally {
    app.unmount();
  }
}

beforeEach(() => {
  setLocale('zh');
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'concertoai-handoff-iso-'));
  // 模块级幂等标志（App 退出路径用 terminal:true）：不复位的话，同一文件里第二个用例
  // 根本不会再写盘，① 会变成「看起来过了但没写」的假绿
  resetHandoffState();
});

afterEach(() => {
  setLocale('zh');
  restoreHome();
  rmSync(tmpHome, { recursive: true, force: true });
  resetHandoffState();
});

describe('① 探针通电：App 真的会写交接单，且钉家目录真的改变落点', () => {
  it('渲染一轮后，`handoffPath(仓库根)` 落在**临时** home 内（且内容是真四栏）', async () => {
    pinHome(tmpHome);
    const pinnedPath = handoffPath(REPO);

    // 自证：两条路径必须是「同一相对形状、不同根」——否则「钉住改变了落点」不成立
    expect(path.basename(pinnedPath)).toBe('handoff.md');
    expect(path.basename(path.dirname(pinnedPath))).toBe(
      path.basename(path.dirname(REAL_PROJECT_HANDOFF)),
    );
    expect(pinnedPath).not.toBe(REAL_PROJECT_HANDOFF);

    await renderOneRound();

    expect(existsSync(pinnedPath), `应写出 ${pinnedPath}`).toBe(true);
    expect(pinnedPath.startsWith(tmpHome), '必须落在临时 home 内').toBe(true);
    const text = readFileSync(pinnedPath, 'utf8');
    expect(text).toContain('## ① 做到哪一步');
    expect(text).toContain('## ④ 为什么退出');
  });
});

describe('② 否定面（本文件视角）：本文件的渲染不得改动真实 home 里那份交接单', () => {
  /**
   * ⚠️ **本条只覆盖「本文件自己那一路写入」，不要把它读成「整个套件干净」**：
   * vitest 的文件是并行跑的，用例只看得见自己 worker 的顺序。变异探针 M1 实测过——
   * 同一个 `npm test` 里真实文件被 `tool-step.test.tsx` 覆盖了（5799B → 460B），本条仍绿。
   * 套件级不变式在 `tests/handoff-home-guard.global.ts`（globalSetup 开始前快照、结束后比对），
   * 那一层才与文件顺序、并行度无关。
   */
  it('真实 `~/.concertoai/handoffs/<本项目>/handoff.md` 的 sha 一字未变', async () => {
    const before = shaOf(REAL_PROJECT_HANDOFF);

    pinHome(tmpHome);
    await renderOneRound();
    // waitFor 已确认临时 home 下那个文件出现 ⇒ 「本该发生的那次写」确实发生了
    const pinnedText = readFileSync(handoffPath(REPO), 'utf8');
    expect(pinnedText.length).toBeGreaterThan(0);
    restoreHome();

    /**
     * 本条不是同义反复：① 已证明「渲染一轮**真的会写**」（否则「没变」可因压根没写而恒真），
     * 而 `handoffPath` 只在 home 上有差别 ⇒ **若没钉家目录，那次写就正好落在 `before` 读过的
     * 那个文件上**。变异探针 M1 实测会让本条红。
     */
    expect(shaOf(REAL_PROJECT_HANDOFF), `真实交接单被测试改了：${REAL_PROJECT_HANDOFF}`).toBe(
      before,
    );
  });
});

describe('③ 静态护栏：挂载真 App 的 UI 用例不许把 cwd 指向仓库根', () => {
  /**
   * 判定：含 `<App` + 出现 `cwd: process.cwd()` ⇒ 违规。
   *
   * ## 为什么判据里**没有**「是否钉了家目录」这一项（第一版有，实测失明）
   *
   * 第一版写成「有 `<App` + `cwd: process.cwd()` + 源码里不含 `USERPROFILE`」。
   * 变异探针 M1（把本仓的 `tool-step.test.tsx` 改回 `cwd: process.cwd()` 且**不调用** `pinHome`）
   * 实测**仍绿**——因为那个文件里 `pinHome` / `restoreHome` 的**函数定义**仍然写着
   * `process.env.USERPROFILE = …`，于是「源码里含 USERPROFILE」成立，护栏就免检了。
   *
   * 教训（AGENTS 判定类护栏第 ③ 条「过滤没放宽到失明」）：**函数定义 ≠ 被调用**，
   * 用「源码里出现过某个字符串」当替代判据，等于让「写了函数但没调」这种最常见的失效形态免检。
   * 改后的判据不再需要判断「有没有真的钉住」——直接把入口形状禁掉：
   * 仓库根不是「某个用例的配置差异」，挂载真 App 时把 cwd 指到仓库根，就会往开发者真实
   * home 写交接单。要用仓库根就写常量（如 `REPO`）并配套钉家目录，别直接写 `process.cwd()`。
   */
  /**
   * 判据必须**只看代码、不看注释**——这是第二处实测出来的失明/误伤（比第一处更阴）：
   * 修好 `tool-step` 之后第一次跑，本条把 `tool-step.test.tsx` 和**本文件自己**都判成违规，
   * 原因是两个文件的**头注释**里都写着「原来的写法是 `ctx={{ cwd: process.cwd() }}`」
   * —— 一句解释缺陷历史的话，让护栏去咬解释者。第一版判据（含 USERPROFILE 就免检）
   * 一样是字面量扫描的毛病：**字面量出现 ≠ 语义成立**，两个方向都会骗人。
   * 所以先剥掉块注释与行注释，再在剩下的代码上匹配。
   */
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

  const violatesIsolation = (source: string): boolean => {
    const code = stripComments(source);
    return code.includes('<App') && /cwd:\s*process\.cwd\(\)/.test(code);
  };

  it('护栏自身有牙：违规样本 ⇒ true；常量 cwd / 临时 cwd / 仅注释里出现 ⇒ false', () => {
    // 样本用拼接构造，避免本文件在**代码行**里出现那个违规形状
    const repoCwd = 'cwd: process.' + 'cwd()';
    const bad = `<App client={c} ctx={{ ${repoCwd} }} />`;
    const constCwd = '<App client={c} ctx={{ cwd: REPO }} />';
    const tmpCwd = '<App client={c} ctx={{ cwd: tmp }} />';
    // 注释里写着「以前是 ctx={{ cwd: process.cwd() }}」不许红（本文件头注释就是这个形状）
    const commentOnly = `/** 以前写的是 ctx={{ ${repoCwd} }} */\n<App client={c} ctx={{ cwd: tmp }} />`;
    expect(violatesIsolation(bad)).toBe(true);
    expect(violatesIsolation(constCwd)).toBe(false);
    expect(violatesIsolation(tmpCwd)).toBe(false);
    expect(violatesIsolation(commentOnly)).toBe(false);
  });

  it('真实 `tests/ui/*.test.tsx` 里没有违规文件（正例自证：确实扫到了挂载 App 的文件）', () => {
    const dir = path.join(REPO, 'tests', 'ui');
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.test.tsx'))
      .map((file) => ({ file, source: readFileSync(path.join(dir, file), 'utf8') }));
    // 正例自证：一个都没扫到的话，下面的「全部合规」是空转
    const mounting = sources.filter((s) => s.source.includes('<App'));
    expect(mounting.length).toBeGreaterThan(0);
    expect(sources.filter((s) => violatesIsolation(s.source)).map((s) => s.file)).toEqual([]);
  });
});
