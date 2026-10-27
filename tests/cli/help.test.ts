/**
 * --help 首屏精简测试（v5.0 T14）+ 首次欢迎引导（v4.1 T2.2）。
 *
 * ## 为什么这里要**真跑 CLI**而不是断言字典字符串
 *
 * T14 的核心承诺是「首屏只给动词、不平铺命令」，而这类承诺的失败方式恰好是
 * 断言字符串抓不到的：
 * - 文案对，但渲染没接上（`configureHelp` 忘挂 → 平铺清单照旧输出，v5.0 实测过一次）；
 * - 首屏写了个不存在的命令（空头支票，T10 / T12 两次踩坑，ADR-044）；
 * - 命令改名 / 删除 / 描述改动后首屏漂移（手写的第二份文案没人会记得同步）。
 *
 * 所以本文件用 tsx 起**真实进程**跑 `concertoai --help` / `--help --all`，
 * 再拿 `Commands:` 段反查「注册表」做交叉校验：首屏每一个名字都必须查得到，
 * 描述必须与注册值逐字相同——首屏因此不可能漂移，也不可能打空头支票。
 *
 * 顺带覆盖：行数预算（≤40 防淹没）、四段顺序、M4 四动词的双向不变量、
 * 斜杠命令走真实解析器。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseHintsCommand } from '../../src/cli/slash/hints';
import { parseReviewCommand } from '../../src/cli/slash/review';
import { parseWorkflowCommand } from '../../src/cli/slash/workflow';
import { en } from '../../src/i18n/en';
import { zh } from '../../src/i18n/zh';

const originalHomedir = os.homedir;
let tmp: string;

/** tsx 入口（与 `npm run dev` 等价，不依赖 dist 构建产物）。 */
const TSX_CLI = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * 起真实 CLI 进程跑帮助（隔离 HOME）。
 *
 * 隔离 HOME 是必须的：入口会碰 `~/.concertoai`（迁移 / 建目录 / 读技能与规则），
 * 不隔离就写进开发者真实 home，并与同批次用例互相干扰（AGENTS 第 16 条）。
 */
function runCliHelp(args: string[], home: string): string {
  return execFileSync(process.execPath, [TSX_CLI, 'src/cli/index.ts', ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CONCERTOAI_HINTS: 'off',
      HOME: home,
      USERPROFILE: home,
    },
  });
}

/** 按「2 个以上空格」切分 commander 的对齐输出 → `[名字(可能带参数), 描述]`。 */
function splitAligned(line: string): [string, string] | undefined {
  const parts = line.trim().split(/\s{2,}/);
  if (parts.length < 2) {
    return undefined;
  }
  return [parts[0] as string, parts.slice(1).join('  ').trim()];
}

/** 取「以 headerPrefix 开头的行」之后的连续非空行（遇到空行即段结束）。 */
function blockAfter(text: string, headerPrefix: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(headerPrefix));
  if (start < 0) {
    return [];
  }
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      break;
    }
    out.push(line);
  }
  return out;
}

/**
 * 从 `--help --all` 的 `Commands:` 段解析出「命令名 → 描述」注册表。
 *
 * 这就是「真实存在」的判据来源：拿它反查首屏，而不是拿首屏自证首屏。
 */
function parseRegistered(helpAll: string): Map<string, string> {
  const lines = helpAll.split(/\r?\n/);
  const start = lines.indexOf('Commands:');
  if (start < 0) {
    throw new Error('--help --all 输出里没有 Commands: 段（commander 输出格式变了？）');
  }
  const registry = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      break;
    }
    const name = /^ {2}(\S+)/.exec(line)?.[1];
    if (name === undefined) {
      continue;
    }
    registry.set(name, splitAligned(line)?.[1] ?? '');
  }
  return registry;
}

/** 去掉尾部空行后的行数（行数预算按「用户真正看到的行」算）。 */
function countLines(text: string): number {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
    lines.pop();
  }
  return lines.length;
}

describe('--help 首屏精简（v5.0 T14，真跑 CLI）', () => {
  let home: string;
  /** `concertoai --help` 的首屏。 */
  let firstScreen: string;
  /** `concertoai --help --all` 的完整输出（含平铺清单）。 */
  let fullHelp: string;
  /** 真实注册表：命令名 → 描述。 */
  let registry: Map<string, string>;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'concertoai-help-'));
    // 两次 spawn 复用同一隔离 HOME（目录在 afterAll 统一清理，且 rmSync 带重试兜 Windows EBUSY）
    firstScreen = runCliHelp(['--help'], home);
    fullHelp = runCliHelp(['--help', '--all'], home);
    registry = parseRegistered(fullHelp);
  }, 300_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('行数预算：首屏 ≤ 40 行且不是空壳（T14 验收，防淹没）', () => {
    const lines = countLines(firstScreen);
    expect(lines).toBeGreaterThanOrEqual(25); // 少得不正常同样是 bug（段落被吞）
    expect(lines).toBeLessThanOrEqual(40);
  });

  it('configureHelp 已挂载：首屏不再平铺命令清单（只有 --all 才列）', () => {
    // 这是 T14 最容易漏的一步——文案改完但 configureHelp 没挂，平铺清单照旧输出
    expect(firstScreen).not.toContain('Commands:');
    expect(fullHelp).toContain('Commands:');
    // 且 --all 的输出确实更长（完整清单真的多给了东西）
    expect(countLines(fullHelp)).toBeGreaterThan(countLines(firstScreen));
  });

  it('四段顺序：快速开始 → 常用命令 → 交互 → 高级', () => {
    const order = [zh.help.fastStart, zh.help.common, zh.help.slash, zh.help.advanced].map((head) =>
      firstScreen.indexOf(head),
    );
    for (const position of order) {
      expect(position).toBeGreaterThan(-1);
    }
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i] as number).toBeGreaterThan(order[i - 1] as number);
    }
  });

  it('常用命令段每一行都真实注册，且描述与注册值逐字相同（不漂移、不手写）', () => {
    const entries = blockAfter(firstScreen, zh.help.common).map(splitAligned);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      expect(entry).toBeDefined();
      const [name, desc] = entry as [string, string];
      expect(registry.has(name), `首屏出现了未注册的命令 ${name}（空头支票）`).toBe(true);
      expect(desc, `${name} 的描述与注册值不一致（手写了第二份文案？）`).toBe(registry.get(name));
    }
  });

  it('快速开始三步引用的命令都真实注册（doctor / init / chat）', () => {
    const verbs = [
      ...blockAfter(firstScreen, zh.help.fastStart)
        .join('\n')
        .matchAll(/concertoai ([a-z][\w-]*)/g),
    ].map((match) => match[1] as string);
    expect(verbs.length).toBeGreaterThanOrEqual(3);
    for (const verb of verbs) {
      expect(registry.has(verb), `快速开始引用了不存在的命令 ${verb}`).toBe(true);
    }
  });

  it('workflow / plugin / team 折叠进「高级」，且常用 ∪ 高级 = 全部注册命令（无遗漏无重复）', () => {
    const common = new Set(
      blockAfter(firstScreen, zh.help.common)
        .map(splitAligned)
        .map((entry) => entry?.[0])
        .filter((name): name is string => name !== undefined),
    );
    const advanced = new Set(
      (blockAfter(firstScreen, zh.help.advanced)[0] ?? '')
        .split('·')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    );
    for (const name of ['workflow', 'plugin', 'team']) {
      expect(advanced.has(name), `${name} 应归入「高级」`).toBe(true);
      expect(common.has(name), `${name} 不该占「常用」位置`).toBe(false);
    }
    // 两处都落下的命令 = 用户在首屏彻底查不到 → 等于被静默删除
    const covered = new Set([...common, ...advanced]);
    for (const name of registry.keys()) {
      expect(covered.has(name), `命令 ${name} 在首屏任何一段都没出现（被静默吞掉）`).toBe(true);
    }
    // 反向：首屏两段里的名字也必须都在注册表里
    for (const name of covered) {
      expect(registry.has(name), `首屏出现了未注册的命令 ${name}`).toBe(true);
    }
  });

  it('M4 四动词双向不变量：未注册则首屏一个字不许出现，注册了必须上首屏', () => {
    for (const verb of ['check', 'fix', 'commit', 'review']) {
      const onFirstScreen = new RegExp(`^ {2}${verb}\\b`, 'm').test(firstScreen);
      if (registry.has(verb)) {
        // M4 落地后：只改 COMMON_COMMAND_ORDER 即可，本断言会盯着它真的生效
        expect(onFirstScreen, `${verb} 已注册却没上首屏（COMMON_COMMAND_ORDER 忘了加？）`).toBe(
          true,
        );
      } else {
        expect(onFirstScreen, `${verb} 尚未注册却出现在首屏（空头支票）`).toBe(false);
      }
    }
  });

  it('`--all` 参数顺序等价：`--help --all` 与 `--all --help` 结果一致', () => {
    const reversed = runCliHelp(['--all', '--help'], home);
    expect(reversed).toBe(fullHelp);
  }, 200_000);

  it('首屏文案全部来自 i18n（没有一份写死在渲染里的第二份副本）', () => {
    const keys = [
      'fastStart',
      'fast1',
      'fast2',
      'fast3',
      'common',
      'commonHint',
      'slash',
      'slashPlan',
      'slashReview',
      'slashWorkflow',
      'slashHints',
      'advanced',
      'advancedHint',
    ] as const;
    for (const key of keys) {
      // 每个键都必须真的被渲染出来（死文案 = 用户看不到的翻译工作量）
      expect(firstScreen, `i18n help.${key} 没有被渲染进首屏（死文案）`).toContain(zh.help[key]);
    }
  });
});

describe('交互段斜杠命令真实存在（不打空头支票）', () => {
  it('`/review` 走真实解析器（不是幻想命令）', () => {
    expect(parseReviewCommand('/review')?.type).toBe('auto');
    expect(parseReviewCommand('/review src/a.ts')).toMatchObject({ paths: ['src/a.ts'] });
  });

  it('`/workflow` 走真实解析器', () => {
    expect(parseWorkflowCommand('/workflow')).not.toBeNull();
  });

  it('`/hints` 走真实解析器（裸命令等价 status）', () => {
    expect(parseHintsCommand('/hints')?.type).toBe('status');
  });

  it('`/plan` 在 TUI 里有真实分派分支（无独立解析器，改查源码分派）', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/ui/App.tsx'), 'utf8');
    expect(source).toContain("startsWith('/plan')");
  });
});

describe('help 段文案完整性（T14 补齐 fast*）', () => {
  it('zh / en 键一一齐全、非空、无残留占位符', () => {
    const keys = [
      'fastStart',
      'fast1',
      'fast2',
      'fast3',
      'common',
      'commonHint',
      'slash',
      'slashPlan',
      'slashReview',
      'slashWorkflow',
      'slashHints',
      'advanced',
      'advancedHint',
    ] as const;
    for (const key of keys) {
      for (const dict of [zh.help, en.help]) {
        const value: string = dict[key];
        expect(value.length).toBeGreaterThan(0);
        expect(value).not.toMatch(/[{}]/); // 未替换的占位符不许漏到用户眼前
      }
    }
  });

  it('旧版「22 条命令示例」文案已彻底退场（不留无人引用的死键）', () => {
    const legacy = ['gettingStarted', 'step1', 'step2', 'step3', 'commands'];
    for (const key of legacy) {
      expect(Object.keys(zh.help)).not.toContain(key);
      expect(Object.keys(en.help)).not.toContain(key);
    }
  });
});

describe('maybePrintWelcome（v4.1 T2.2）', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeAll(() => {
    // 隔离全局目录：把 os.homedir 指向临时目录，避免污染真实 ~/.concertoai
    tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-welcome-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });

  afterAll(() => {
    os.homedir = originalHomedir;
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('首次（无标记文件）→ 打印欢迎 + 创建标记文件', async () => {
    const { maybePrintWelcome } = await import('../../src/cli/chat');
    maybePrintWelcome();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('欢迎使用 ConcertoAI');
    expect(out).toContain('concertoai doctor');
    // 标记文件已创建
    expect(existsSync(path.join(tmp, '.concertoai', '.welcome-seen'))).toBe(true);
  });

  it('再次（标记文件已存在）→ 不再打印', async () => {
    writeFileSync(path.join(tmp, '.concertoai', '.welcome-seen'), 'seen', 'utf8');
    const { maybePrintWelcome } = await import('../../src/cli/chat');
    maybePrintWelcome();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
