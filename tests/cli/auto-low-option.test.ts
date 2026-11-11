/**
 * `--auto-low` 的**双入口**参数测试（v5.1 T1.2，判据 C4）。
 *
 * ## 为什么这条必须单独存在（不能只靠 UI 集成用例）
 *
 * 本仓 chat 有**两个入口**：
 *   ① 无子命令 → `program.action(...)`（产品定位 `cd 项目 && concertoai`，用户日常路径）；
 *   ② 显式 `concertoai chat`。
 *
 * 只在②上挂参数时，UI 集成用例照样全绿（它们直接渲染 `<App autoLow />`，根本不走 CLI），
 * 而用户敲 `npm run dev -- --auto-low` 会直接 `unknown option` 失败。
 * 所以这里**必须起真进程**跑真 CLI，断言两个入口都认这个参数、且帮助文案里能查到。
 *
 * ## 探针纪律
 *
 * 把 `addAutoLowOption(program)` 那次的调用删掉（只留子命令那次）⇒ 本文件
 * 「无子命令入口」两条用例必须红。只断言子命令会漏掉用户日常那条路径。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveAutoLowFlag } from '../../src/cli/auto-low-flag';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

/**
 * 起真 CLI 进程。
 *
 * - 用 `tsx` 跑源码（与 `npm run dev` 同一条路，不依赖 `dist` 是否构建过）；
 * - **显式钉死 locale**（AGENTS 硬要求：不依赖开发机 shell）——
 *   帮助文案要断言中文，就必须保证父进程没漏进 `LUMEN_LOCALE=en`。
 */
function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), CLI, ...args],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, LUMEN_LOCALE: '', LANG: '', ...env },
    },
  );
}

describe('--auto-low：两个入口都注册（探针：删任一处注册 ⇒ 对应用例红）', () => {
  it('chat 子命令：`chat --help` 里能查到 --auto-low', () => {
    const r = runCli(['chat', '--help']);
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('--auto-low');
  });

  it('**无子命令入口**：`--help`（根命令）里能查到 --auto-low', () => {
    const r = runCli(['--help']);
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('--auto-low');
  });

  it('chat 子命令：`--auto-low` 不被当成 unknown option', () => {
    // 不带 --help：会真的进 chat；非 TTY 下 chat 立刻友好退出（exit 1），
    // 所以我们断言的是「**没有** unknown option 报错」，而不是 exit 0。
    const r = runCli(['chat', '--auto-low']);
    const combined = `${r.stdout}${r.stderr}`;
    expect(combined).not.toMatch(/unknown option/i);
    expect(combined).not.toMatch(/未知选项/);
  });

  it('**无子命令入口**：`--auto-low` 不被当成 unknown option（用户日常路径）', () => {
    const r = runCli(['--auto-low']);
    const combined = `${r.stdout}${r.stderr}`;
    expect(combined).not.toMatch(/unknown option/i);
    expect(combined).not.toMatch(/未知选项/);
  });

  it('帮助文案说清「默认关」且**不出现「安全」二字**（low ≠ 安全）', () => {
    const r = runCli(['chat', '--help']);
    const line = r.stdout.split('\n').find((l) => l.includes('--auto-low')) ?? '';
    expect(line).toContain('默认关');
    expect(line).not.toContain('安全');
  });

  it('--auto-low 与既有 --auto-approve 不是同一个选项（防同名不同义混用）', () => {
    const chatHelp = runCli(['chat', '--help']).stdout;
    expect(chatHelp).toContain('--auto-low');
    // chat 不该有 --auto-approve（那是 run/plan/team/self-heal/fix 的全批开关）
    expect(chatHelp).not.toContain('--auto-approve');
  });
});

/**
 * `--auto-low` 的**取值**是否真的落到 `runChat`（v5.1 T3.2 补）。
 *
 * ## 为什么「上面的注册用例全绿」还不够（这条补的就是那个漏洞）
 *
 * `b070b30` 版的两个入口用例只断言「不报 unknown option」——**参数被接受**与
 * **值被传下去**是两件事。真机 PTY 跑 `chat --auto-low` 抓到的实际形态是：
 *
 * ```
 * chat-action options={} rootOpts={"autoLow":true}   ← 父命令把子命令的同名 flag 吃掉了
 * runChat autoLow=false                            ← 用户敲了开关，功能没生效，且不报错
 * ```
 *
 * 于是 `--auto-low` 在子命令入口上等于白敲：审批框照旧弹，界面一切正常。
 * 修法是把两级取值合并（`src/cli/auto-low-flag.ts`），用例必须钉住「只有根命令为 true」
 * 这一格——那一格才是真机形态。
 *
 * ## 变异探针（都跑过，均有牙）
 *
 * - 把 `subcommand === true || root === true` 改成只看 `subcommand` ⇒ 第 ② 条红；
 * - 改成只看 `root` ⇒ 第 ① 条红；
 * - 把 `=== true` 放宽成 `Boolean(x)` ⇒ 第 ④ 条（`'false'` 字符串）红。
 */
describe('--auto-low 取值合并（真机形态：父命令吃掉子命令的同名 flag）', () => {
  it('① 子命令自己解析到 true（`chat --auto-low`）⇒ 启用', () => {
    expect(resolveAutoLowFlag({ subcommand: true, root: undefined })).toBe(true);
  });

  it('② 只有根命令为 true（**真机 `chat --auto-low` 的实际形态**）⇒ 仍然启用', () => {
    expect(resolveAutoLowFlag({ subcommand: undefined, root: true })).toBe(true);
  });

  it('③ 两级都没有（默认不带参数）⇒ 不启用（默认行为不变）', () => {
    expect(resolveAutoLowFlag({ subcommand: undefined, root: undefined })).toBe(false);
    expect(resolveAutoLowFlag({})).toBe(false);
  });

  it('④ 非布尔真值一律不启用（`"false"` / `"true"` / `1` 都不算开了）', () => {
    for (const bogus of ['false', 'true', '1', 1, 0, null, {}]) {
      expect(resolveAutoLowFlag({ subcommand: bogus, root: bogus })).toBe(false);
    }
  });

  it('⑤ 两级都显式 false ⇒ 不启用（不会被 `||` 误判）', () => {
    expect(resolveAutoLowFlag({ subcommand: false, root: false })).toBe(false);
  });
});

/**
 * 源码护栏：`index.ts` 的两个入口**必须**走 `autoLowFrom` 合并（v5.1 T3.2）。
 *
 * ## 为什么纯函数用例不够（这条补的是「护栏缺口」）
 *
 * 上面 5 条只证明 `resolveAutoLowFlag` 本身算得对。把 `index.ts` 里的
 * `autoLow: autoLowFrom(options)` 改回 `options.autoLow === true`（即退回 `b070b30`
 * 的 bug 版），**5 条全绿**——纯函数压根没被绕过，它只是**没人调用**了。
 * 这正是 AGENTS 说的「该红必红」缺半边：护栏必须管住**接线点**，而不只是管住函数体。
 *
 * ## 变异探针（跑过，有牙）
 *
 * - 把 `autoLow: autoLowFrom(options)` 改回 `options.autoLow === true` ⇒ 第 ② 条红；
 * - 把 `autoLow: autoLowFrom({})` 改回 `program.opts().autoLow === true` ⇒ 第 ② 条红。
 *
 * ## 正例自证（AGENTS「检索类要先证探针通电」）
 *
 * 第 ① 条先断言「文件读到了、`autoLowFrom` 定义在」。没有这一条，路径写错 / 文件被改名时
 * 下面的 `not.toContain` 会**全绿**（对一个读空串的断言来说，「不存在」永远成立）。
 */
describe('源码护栏：两个入口的取值都必须经 autoLowFrom 合并', () => {
  const source = (): string => fs.readFileSync(CLI, 'utf8');

  it('① 正例自证：源码读到了，锚点都在（否则后面的否定断言是空转）', () => {
    const text = source();
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain('function autoLowFrom(');
    expect(text).toContain('resolveAutoLowFlag');
  });

  it('② 两个入口都调用 autoLowFrom（根入口 = `{}`，chat 入口 = 自己的 options）', () => {
    const text = source();
    expect(text).toContain('autoLow: autoLowFrom({})');
    expect(text).toContain('autoLow: autoLowFrom(options)');
  });

  it('③ 否定面：不许回到「只读一级」的旧写法（两种都算回归）', () => {
    const text = source();
    expect(text).not.toContain('autoLow: options.autoLow === true');
    expect(text).not.toContain('autoLow: program.opts().autoLow === true');
  });
});
