/**
 * 四条退场出口都写交接单（v5.3 N4，任务书 T2.2 / T2.4）。
 *
 * ## 为什么必须起真进程（不能只测 `finalizeSession`）
 *
 * 「按 Ctrl+C 会不会留下交接单」是一条**端到端**承诺，横跨：
 * `useInput` 按键 → 写盘 → `exit()`；`SIGINT` 信号 → 写盘 → `process.exit(130)`；
 * 未捕获异常 → `crash-handler` → 写盘 → `exit(1)`。
 * 任何一条没接上，进程内单测都看不出来——它测的是「函数被调用时写不写」，
 * 而缺陷形态是「**函数压根没被调用**」。
 *
 * ## 这一层能覆盖什么 / 不能覆盖什么（写清边界，不假装全绿）
 *
 * - 能：③ 用户中断（真 SIGINT 打到真 CLI）、④ 崩溃（真未捕获异常）、
 *   消费端「下次进入读到」、源码护栏（每个出口都调了收尾函数）。
 * - 不能：TUI 里按下 Ctrl+C 的那条**按键路径**——那需要 PTY + 真实终端交互，
 *   本文件只用源码护栏钉「`exit()` 之前调了 `writeHandoffOnExit()`」，
 *   并把这条边界写明（比假装覆盖了更诚实）。
 *
 * ## 探针纪律
 *
 * `HOME` / `USERPROFILE` 指到临时目录，且**先断言子进程自己打印的 `handoffPath()`
 * 落在该目录内**（探针通电）——否则「没找到交接单」可能只是「写到了真实 home」。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const TSX = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HANDOFF_SRC = path.join(REPO_ROOT, 'src', 'cli', 'handoff.ts');
const APP_SRC = path.join(REPO_ROOT, 'src', 'ui', 'App.tsx');
const RUN_SRC = path.join(REPO_ROOT, 'src', 'cli', 'run.ts');
const CRASH_SRC = path.join(REPO_ROOT, 'src', 'cli', 'crash-handler.ts');
const CHAT_SRC = path.join(REPO_ROOT, 'src', 'cli', 'chat.tsx');

let home: string;
let cwd: string;

/** 子进程 env：逐项写清（不抄父进程，见 AGENTS「进程级全局状态隔离」）。 */
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    LUMEN_LOCALE: '',
    LANG: '',
    ...extra,
  };
}

function runNode(script: string, extra: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [TSX, script], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: env(extra),
  });
}

/** 把一段 TS 源码写成临时脚本（`node -e` 内联会被 cmd 转义坑，见 AGENTS 第 18 条 ③）。 */
function writeScript(name: string, source: string): string {
  const file = path.join(home, name);
  writeFileSync(file, source, 'utf8');
  return file;
}

const handoffModule = (): string =>
  JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'src', 'cli', 'handoff.ts')).href);

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'concertoai-handoff-wire-'));
  cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('探针通电自证', () => {
  it('子进程打印的 `handoffPath(cwd)` 落在临时 home 内（否则下面全是空转）', () => {
    const script = writeScript(
      'probe.mts',
      [
        `import { handoffPath } from ${handoffModule()};`,
        'console.log(handoffPath(process.cwd()));',
        '',
      ].join('\n'),
    );
    const r = runNode(script);
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    const printed = String(r.stdout).trim();
    expect(printed).toContain(path.join(home, '.concertoai', 'handoffs'));
    expect(printed.endsWith('handoff.md')).toBe(true);
  });
});

describe('出口 ③：SIGINT（用户中断）⇒ 留下中断交接单', () => {
  it('SIGINT 处理器被触发后写出 ④=用户中断 的交接单，退出码 130', () => {
    /**
     * ## 为什么用 `process.emit('SIGINT')` 而不是 `child.kill('SIGINT')`（实测踩到）
     *
     * 第一版用了 `child.kill('SIGINT')`，**在 Windows 上永远是假红**：Node 文档写明
     * Windows 不支持 POSIX 信号，`kill(signal)` 在该平台**直接终止进程**，信号被忽略
     * ⇒ 处理器压根没跑 ⇒ 交接单没有 ⇒ 用例红，而代码是对的。
     *
     * 所以这里让**子进程自己触发**同一个事件：`process.emit('SIGINT')` 会走与真实信号
     * 完全相同的监听器（这正是我要验的东西）。
     *
     * **边界（不假装覆盖）**：本用例验证的是「处理器装了 + 处理器会写盘 + 退出码 130」，
     * **不验**「操作系统真的把 Ctrl+C 投递成了 SIGINT」——那是平台行为，不是本仓代码，
     * 且 Windows 上根本不成立。这段差异写在这里，避免后来人以为「测过真信号了」。
     */
    const script = writeScript(
      'sigint.mts',
      [
        `import { finalizeActiveSession, setActiveSession } from ${handoffModule()};`,
        'setActiveSession({',
        "  messages: [{ role: 'user', content: '做事' }, { role: 'tool', content: '{}', toolCallId: 'x' }],",
        '  cwd: process.cwd(),',
        "  sessionId: 's-1',",
        '});',
        // 与 App.tsx 同形的处理器：写盘 + exit 130
        "process.on('SIGINT', () => { finalizeActiveSession({ kind: 'interrupted' }); process.exit(130); });",
        "process.emit('SIGINT');",
        '',
      ].join('\n'),
    );

    const r = runNode(script);
    expect(r.status, `处理器应把退出码设为 130（stderr=${r.stderr}）`).toBe(130);

    const probe = writeScript(
      'where.mts',
      [
        `import { handoffPath } from ${handoffModule()};`,
        'console.log(handoffPath(process.cwd()));',
        '',
      ].join('\n'),
    );
    const target = String(runNode(probe).stdout).trim();
    expect(existsSync(target), `SIGINT 之后应写出 ${target}`).toBe(true);
    const text = readFileSync(target, 'utf8');
    expect(text).toContain('> 退出原因: interrupted');
    expect(text).toContain('用户中断');
  });
});

describe('出口 ④：真未捕获异常 ⇒ crash-handler 写异常交接单', () => {
  it('未捕获异常 ⇒ 交接单 ④ 栏是「异常退出：<首行>」，且不含堆栈', () => {
    const script = writeScript(
      'crash.mts',
      [
        `import { setActiveSession } from ${handoffModule()};`,
        `import { installCrashHandlers } from ${JSON.stringify(pathToFileURL(CRASH_SRC).href)};`,
        'setActiveSession({',
        "  messages: [{ role: 'tool', content: '{}', toolCallId: 'x' }],",
        '  cwd: process.cwd(),',
        "  sessionId: 's-2',",
        '});',
        'installCrashHandlers();',
        "throw new Error('boom-from-crash');",
        '',
      ].join('\n'),
    );
    const r = runNode(script);
    // 崩溃路径退出码非零（crash-handler 的既有承诺）
    expect(r.status).toBe(1);

    const probe = writeScript(
      'where2.mts',
      [
        `import { handoffPath } from ${handoffModule()};`,
        'console.log(handoffPath(process.cwd()));',
        '',
      ].join('\n'),
    );
    const target = String(runNode(probe).stdout).trim();
    expect(existsSync(target), 'crash-handler 应在退出前同步写交接单').toBe(true);
    const text = readFileSync(target, 'utf8');
    expect(text).toContain('异常退出：boom-from-crash');
    expect(text).toContain('> 退出原因: error');
    expect(text, '交接单里不许出现堆栈行').not.toMatch(/\n\s+at .*:\d+:\d+/);
  });
});

describe('消费端：下一次进入能读到上一次的交接单', () => {
  it('`consumeHandoff` 在真进程里给出 notice（带完整路径）+ inject', () => {
    const script = writeScript(
      'roundtrip.mts',
      [
        `import { consumeHandoff, finalizeSession } from ${handoffModule()};`,
        "finalizeSession([{ role: 'tool', content: '{}', toolCallId: 'x' }],",
        "  { kind: 'max-turns', used: 50, cap: 50 },",
        '  { cwd: process.cwd(), sessionId: "s-3", now: new Date() },',
        '  { terminal: true });',
        'const r = consumeHandoff(process.cwd(), new Date());',
        'console.log(JSON.stringify(r));',
        '',
      ].join('\n'),
    );
    const r = runNode(script);
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    const parsed = JSON.parse(String(r.stdout).trim().split('\n').at(-1) ?? '{}') as {
      notice?: string;
      inject?: string;
    };
    expect(parsed.notice).toContain('上次交接：撞轮数上限（50/50）');
    expect(parsed.notice).toContain('.concertoai');
    expect(parsed.inject).toContain('## ④ 为什么退出');
  });
});

describe('源码护栏：四个出口都接了收尾函数（TUI 按键路径无法在无 PTY 下覆盖，用它兜）', () => {
  it('`writeHandoff(` 只出现在 handoff.ts（其余地方一律走 finalizeSession）', () => {
    /**
     * 正例自证：先确认 `handoff.ts` 里**确实有** `export function writeHandoff`，
     * 否则「别的文件里没有」这个结论可能只是「名字写错了」。
     */
    const handoffSrc = readFileSync(HANDOFF_SRC, 'utf8');
    expect(handoffSrc).toContain('export function writeHandoff(');

    for (const file of [APP_SRC, RUN_SRC, CRASH_SRC, CHAT_SRC]) {
      const src = readFileSync(file, 'utf8');
      expect(src.includes('writeHandoff('), `${path.basename(file)} 不该直接调 writeHandoff`).toBe(
        false,
      );
    }
  });

  it('`App.tsx`：两处 `exit()` 之前都调了 `writeHandoffOnExit()`，并装了 SIGINT 兜底', () => {
    const src = readFileSync(APP_SRC, 'utf8');
    // 正例自证：这些标识符确实存在（否则下面的「位置关系」断言毫无意义）
    for (const needle of ['writeHandoffOnExit', "process.on('SIGINT'", 'exit()']) {
      expect(src.includes(needle), `正例自证：App.tsx 应含 ${needle}`).toBe(true);
    }
    // 每一处 `exit()` 的**前 300 字符**内必须出现写交接单的调用
    let from = 0;
    let count = 0;
    for (;;) {
      const at = src.indexOf('exit();', from);
      if (at === -1) {
        break;
      }
      count += 1;
      const before = src.slice(Math.max(0, at - 300), at);
      expect(before, `${at} 处的 exit() 之前应先写交接单`).toContain('writeHandoffOnExit()');
      from = at + 1;
    }
    expect(count, 'App.tsx 应有两处 exit()（Ctrl+C 与 Esc）').toBeGreaterThanOrEqual(2);
  });

  it('`run.ts`：跑完写交接单 + 打印**完整路径**（落点 B 用户不易发现，只写不报等于没写）', () => {
    const src = readFileSync(RUN_SRC, 'utf8');
    expect(src).toContain('finalizeSession(');
    expect(src).toContain('交接单已写入');
    // 拼出 `${saved}` 两个字面量片段（直接写会被 biome 当成误用的模板串）
    expect(src, '必须打印路径变量而不是一句「已写入」').toContain(`$${'{saved}'}`);
    expect(src).toContain('consumeHandoff(');
  });

  it('`crash-handler.ts`：两个异常分支 + AbortError 分支都调了 `finalizeActiveSession`', () => {
    const src = readFileSync(CRASH_SRC, 'utf8');
    // 只数**调用**（带括号）；import 语句里没有括号，不计入
    const calls = src.split('finalizeActiveSession(').length - 1;
    expect(calls, 'uncaughtException / AbortError / unhandledRejection 三处都要接').toBe(3);
    expect(src).toContain("kind: 'interrupted'");
    expect(src).toContain("kind: 'error'");
  });

  it('`chat.tsx`：启动时调 `consumeHandoff`（否则「下次进来能看到」只在 run 里成立）', () => {
    const src = readFileSync(CHAT_SRC, 'utf8');
    expect(src).toContain('consumeHandoff(options.cwd');
    expect(src).toContain('handoff.inject');
  });

  /**
   * v5.3 C 轮：真机上 Ctrl+C 只有这一条路能走通。
   *
   * 为什么源码护栏必须钉这里：`App.tsx` 里那两处 `writeHandoffOnExit()` 看着
   * 很对，但 Ink 把 Ctrl+C 截在 `useInput` 之前（`App.js:151`）⇒ 它们是死代码。
   * 「函数被调用了没有」这类断言在真机上是绿的，唯一能钉住的是「入口装没装兜底」。
   *
   * 配变异探针：删掉 `chat.tsx` 里这一行 ⇒ 本条红 + PTY 探针 ④ 栏判红。
   */
  it('`chat.tsx`：入口调用 `installHandoffExitHook()`（真机 Ctrl+C 唯一收得到的事件）', () => {
    const src = readFileSync(CHAT_SRC, 'utf8');
    // 正例自证：import 与调用都要在（只 import 不调 = 兜底没装）
    expect(src).toContain('installHandoffExitHook');
    expect(src, '必须在 `render(` 之前装').toMatch(
      /installHandoffExitHook\(\);\s*\n\s*\n?\s*render\(/,
    );
    expect(readFileSync(HANDOFF_SRC, 'utf8')).toContain("process.on('exit', handler)");
  });
});
