/**
 * commander 报错的端到端本地化（v5.0 C1）—— **真进程**跑 CLI。
 *
 * ## 为什么纯函数矩阵不够，必须再起进程
 *
 * `cli-errors.test.ts` 证明的是「输入 code → 输出什么措辞」。它**管不住**最常见的那类失败：
 * - 配置没接上（`configureOutput` / `exitOverride` 忘了挂）→ 用户照旧看到英文；
 * - 挂晚了（写在注册子命令之后）→ **只有根级选项走新逻辑，子命令仍打英文**。
 *   这条是实测踩到的：初版把两行放在文件末尾，`concertoai run`（缺参）依然全英文，
 *   而 `concertoai -p` 已经中文 —— 症状表现为「一半中文一半英文」，极容易被误判成
 *   「某些 code 没映射」，从而去改映射表（改错地方）。
 * - 退出码被 `exitOverride` 弄丢 → 报错却 exit 0（CI 直接放行）。
 *
 * 三种都只有在**真进程**里才看得见，所以本文件用 tsx 起真实 CLI。
 *
 * ## 两条隔离纪律（AGENTS）
 *
 * - `HOME` / `USERPROFILE` 指向临时目录：入口会碰 `~/.concertoai`，不隔离就写进开发者真实 home；
 * - `LUMEN_LOCALE` **显式指定**（不依赖开发机 shell）：否则本机是英文环境时 zh 用例全红。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** tsx 入口（与 `npm run dev` 等价，不依赖 dist 构建产物）。 */
const TSX_CLI = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** CJK 统一汉字区。 */
const CJK = /[\u4e00-\u9fff]/;

let home: string;

/** 一条命令的真实运行结果（stdout / stderr / 退出码）。 */
interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * 起真实 CLI（隔离 HOME + 显式 locale）。
 *
 * 用 `execFileSync` + 捕获异常：退出码非 0 时它会抛 `Error`，`status` 挂在 `error.status` 上。
 * **不能**用 spawnSync 之外的方式「顺便拿输出」——报错路径的 stderr 正是被断言的对象。
 */
function runCli(args: string[], locale: 'zh' | 'en'): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    CONCERTOAI_HINTS: 'off',
    HOME: home,
    USERPROFILE: home,
    LUMEN_LOCALE: locale,
  };
  try {
    const stdout = execFileSync(process.execPath, [TSX_CLI, 'src/cli/index.ts', ...args], {
      encoding: 'utf8',
      timeout: 180_000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      status: typeof failure.status === 'number' ? failure.status : -1,
    };
  }
}

/** zh / en 各跑一遍同一条命令，缓存结果（每条命令要起两个进程，只起一次）。 */
const cache = new Map<string, { zh: RunResult; en: RunResult }>();

function runBoth(args: string[]): { zh: RunResult; en: RunResult } {
  const key = args.join('\u0000');
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const both = { zh: runCli(args, 'zh'), en: runCli(args, 'en') };
  cache.set(key, both);
  return both;
}

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'concertoai-c1-'));
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('未知命令 / 未知选项：中文优先（C1 用户报的那两条）', () => {
  it('bogus-xyz：中文说「没有这个命令」，退出码 1，且不再出现 error: 前缀', () => {
    const { zh } = runBoth(['bogus-xyz']);
    expect(zh.status).toBe(1);
    expect(zh.stderr).toContain('没有这个命令：bogus-xyz');
    expect(zh.stderr).toContain('--help --all'); // 无候选时给「查看全部命令」
    expect(zh.stderr).not.toContain('error:');
    // 也不许把 commander 的口径（参数太多）当结论
    expect(zh.stderr).not.toContain('Expected 0 arguments');
  });

  it('docter：给出真实候选 doctor（候选来自注册表，不是编造）', () => {
    const { zh } = runBoth(['docter']);
    expect(zh.status).toBe(1);
    expect(zh.stderr).toContain('没有这个命令：docter');
    expect(zh.stderr).toContain('`doctor`');
  });

  it('--providr：中文说「没有这个选项」+ 候选 --provider', () => {
    const { zh } = runBoth(['--providr', 'x']);
    expect(zh.status).toBe(1);
    expect(zh.stderr).toContain('没有这个选项：--providr');
    expect(zh.stderr).toContain('`--provider`');
    expect(zh.stderr).not.toContain('error:');
  });

  it('--bogus-opt：不给瞎猜的候选，老实指路 --help', () => {
    const { zh } = runBoth(['--bogus-opt']);
    expect(zh.status).toBe(1);
    expect(zh.stderr).toContain('没有这个选项：--bogus-opt');
    expect(zh.stderr).toContain('concertoai --help');
    expect(zh.stderr).not.toContain('你是不是想输入');
  });
});

describe('缺参 / 多参：**子命令**也要走新逻辑（挂载时机回归）', () => {
  // 这一组是「configureOutput / exitOverride 写在文件末尾」的直接回归用例：
  // 挂晚了，子命令（run / plugin / workflow）仍打英文，而根级选项（-p）已中文。
  it('run（缺必需参数 task）→ 中文，退出码 1', () => {
    const { zh } = runBoth(['run']);
    expect(zh.status).toBe(1);
    expect(zh.stderr).toContain('缺少必需参数：task');
    expect(zh.stderr).not.toContain('missing required argument');
  });

  it('run a b（多给一个参数）→ 说清命令、期望几个、收到什么', () => {
    const { zh } = runBoth(['run', 'a', 'b']);
    expect(zh.status).toBe(1);
    expect(zh.stderr).toContain('concertoai run 只接受 1 个参数，收到 2 个：a, b');
    expect(zh.stderr).not.toContain('too many arguments');
  });

  it('plugin / workflow（缺 action）→ 中文（两个不同子命令，证明不是只挂在 run 上）', () => {
    for (const args of [['plugin'], ['workflow']]) {
      const { zh } = runBoth(args);
      expect(zh.status).toBe(1);
      expect(zh.stderr).toContain('缺少必需参数：action');
    }
  });

  it('-p 缺值 → 中文，且显示长选项名 --project（不是整串 -p, --project <name>）', () => {
    const { zh } = runBoth(['-p']);
    expect(zh.status).toBe(1);
    expect(zh.stderr).toContain('选项 --project 缺少参数值');
    expect(zh.stderr).not.toContain('<name>');
  });
});

describe('en 下全英文、零 CJK（同用例先自证 zh 侧确有 CJK）', () => {
  it('六种错误形态逐条双向断言', () => {
    const cases = [
      ['bogus-xyz'],
      ['docter'],
      ['--providr', 'x'],
      ['run'],
      ['run', 'a', 'b'],
      ['-p'],
    ];
    for (const args of cases) {
      const { zh, en } = runBoth(args);
      // 探针通电：zh 侧真的输出中文（否则下面的「en 无 CJK」可能因两边都空而空转）
      expect(zh.stderr, `zh 侧应有中文: ${args.join(' ')}`).toMatch(CJK);
      expect(en.stderr, `en 侧不应有中文: ${args.join(' ')}`).not.toMatch(CJK);
      expect(en.stderr.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('成功路径不许被 exitOverride 弄坏（最容易翻车的一条）', () => {
  it('--version：退出码 0，stdout 是版本号，stderr 为空', () => {
    const { zh, en } = runBoth(['--version']);
    expect(zh.status).toBe(0);
    expect(zh.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(zh.stderr).toBe('');
    expect(en.status).toBe(0);
  });

  it('--help：退出码 0，输出含用法与分组引导（帮助正文没被 outputError 抑制）', () => {
    const { zh } = runBoth(['--help']);
    expect(zh.status).toBe(0);
    expect(zh.stdout).toContain('Usage: concertoai');
    expect(zh.stdout).toContain('快速开始');
  });

  it('子命令 help（plugin --help）也完好：退出码 0 且打出用法', () => {
    const { zh } = runBoth(['plugin', '--help']);
    expect(zh.status).toBe(0);
    expect(zh.stdout).toContain('Usage:');
  });
});
