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
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
