/**
 * 动词一致性护栏（v5.0 M4 / T19）。
 *
 * ## 为什么护栏要写成**测试**而不是文档里的一句口号
 *
 * M4 的价值全在「4 个动词都是薄包装、都不越权」这两条上。它们腐化的方式非常安静：
 * - 某天有人为了省事在 `commit.ts` 里 `execSync('npm run verify')` 写第二套体检
 *   → 双份耗时 + 双份失败面（v4.1.1「装好却跑不通」的同类分叉）；
 * - 某天有人在某个动词里加一句远程调用 / 强制参数 → 越权悄悄发生，文档不会有人更新；
 * - 某天有人复制一份 verify 解析器 → 两套结论，谁对谁错没人知道。
 *
 * 这些都是**代码层面的不变量**，靠人读文档是防不住的，所以写成断言。
 *
 * ## 三个护栏
 *
 * 1. **不越权（决策 D3-B）**：`src/cli/**` 的源码里绝不出现危险 git 子命令
 *    （push / pull / fetch / rebase / merge / reset / checkout / switch / …）与危险开关
 *    （`--no-verify` / `--force-with-lease` / `--force`——唯一豁免是 `init` 的文件覆盖开关，
 *    那跟 git 无关，且豁免位置写死可核对）；
 * 2. **不重复（G6 薄包装）**：`commit.ts` 必须依赖 `check.ts` 的 `runCheck`；
 *    verify 分类器全项目**只有一处**（`src/loop/self-heal/classifier.ts`），`src/cli` 里
 *    一个都不许有；四段摘要只从 `src/utils/error-summary` 取；
 * 3. **反向验证**：护栏本身要能失败——喂它一段故意违规的合成源码，必须抓到。
 *    「永远绿的护栏」等于没有护栏，所以每个红线都有一个负面样本。
 *
 * `--help` 首屏（4 动词在最显眼处、workflow/plugin/team 归「高级」）由
 * `tests/cli/help.test.ts` 用**真实进程**跑 `concertoai --help` 断言，不在这里重复。
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** 仓库根（本文件在 tests/cli/ 下）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** M4 的四个动词（源码文件 `src/cli/<verb>.ts` 必须存在）。 */
const VERBS = ['check', 'fix', 'commit', 'review'] as const;

/**
 * 危险 git 子命令（决策 D3-B：只做本地提交，绝不碰远程、绝不改写历史）。
 *
 * 注意 `commit` 不在表里——它是本工具唯一会用的写入类子命令，且是本地操作。
 */
const DANGEROUS_GIT_SUBCOMMANDS: readonly string[] = [
  'push',
  'pull',
  'fetch',
  'rebase',
  'merge',
  'reset',
  'checkout',
  'switch',
  'cherry-pick',
  'revert',
  'stash',
  'remote',
  'tag',
  'clean',
  'filter-branch',
];

/** 危险开关（绕过检查 / 强制覆盖）。 */
const DANGEROUS_FLAGS: readonly string[] = ['--no-verify', '--force', '--force-with-lease'];

/**
 * `--force` 的**唯一**豁免：`init` 的文件覆盖开关（与 git 无关）。
 *
 * 判据写死在这一行的片段上：任何新增的 `--force` 都必须显式改这份豁免，
 * 于是「顺手加个强制开关」不可能悄悄过护栏。
 */
const FORCE_ALLOWLIST_FRAGMENT = 't().cli.init.force';

/** 去掉源码注释（JSDoc 里写着「**不**碰远程」，直接子串检查会把否认当罪证）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** 递归列出目录下的 `.ts` / `.tsx` 源码（绝对路径）。 */
function listSources(relDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(ROOT, relDir));
  return out.sort();
}

/** 绝对路径 → 仓库内相对路径（正斜杠，报错信息在 Windows 下也可读）。 */
function toRepoPath(absolute: string): string {
  return path.relative(ROOT, absolute).split('\\').join('/');
}

/**
 * 扫描一段源码，返回全部「越权」违规（空数组 = 干净）。
 *
 * **纯函数**：真实源码与合成负样本走同一条判定，所以「护栏能抓违规」这件事
 * 可以被测试直接证明，而不是靠相信。
 */
function findVerbViolations(source: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];

  // ① 命令字符串形态：`git push origin main` 这类
  for (const match of code.matchAll(/\bgit\s+([a-z][a-z-]*)/gi)) {
    const sub = (match[1] ?? '').toLowerCase();
    if (DANGEROUS_GIT_SUBCOMMANDS.includes(sub)) {
      violations.push(`git ${sub}`);
    }
  }

  // ② 参数数组形态：`git(['push', ...])` / `listGit([...])` / `spawn('git', ['push', ...])`
  //
  // 三种形态都要扫：前两种是本项目的注入点写法，第三种是最容易「绕过注入点」
  // 直接起子进程的写法（反向验证用例专门盯它）。
  const argArrayPatterns = [
    /\b(?:git|listGit)\(\s*\[([^\]]*)\]/g,
    /\bspawn\(\s*['"]git['"]\s*,\s*\[([^\]]*)\]/g,
    /\bexecFile\(\s*['"]git['"]\s*,\s*\[([^\]]*)\]/g,
  ];
  for (const pattern of argArrayPatterns) {
    for (const call of code.matchAll(pattern)) {
      for (const literal of (call[1] ?? '').matchAll(/['"]([^'"]*)['"]/g)) {
        const value = (literal[1] ?? '').toLowerCase();
        if (DANGEROUS_GIT_SUBCOMMANDS.includes(value) || DANGEROUS_FLAGS.includes(value)) {
          violations.push(`git 参数 '${value}'`);
        }
      }
    }
  }

  // ③ git 专属危险开关（出现即违规，无豁免）
  for (const flag of ['--no-verify', '--force-with-lease']) {
    if (code.includes(flag)) {
      violations.push(flag);
    }
  }

  // ④ `--force`：除 init 的文件覆盖开关外，一律算越权
  for (const line of code.split('\n')) {
    if (line.includes('--force') && !line.includes(FORCE_ALLOWLIST_FRAGMENT)) {
      violations.push(`--force（${line.trim().slice(0, 60)}）`);
    }
  }

  return violations;
}

// ── 护栏一：不越权（决策 D3-B）────────────────────────────────

describe('护栏一：4 个动词绝不越权（决策 D3-B）', () => {
  it('真实源码：`src/cli/**` 零违规（有违规会打出文件与原因）', () => {
    const offenders: string[] = [];
    for (const file of listSources('src/cli')) {
      for (const violation of findVerbViolations(readFileSync(file, 'utf8'))) {
        offenders.push(`${toRepoPath(file)} → ${violation}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('扫描范围自证：确实扫到了 4 个动词文件 + 入口（防「扫空目录也绿」）', () => {
    const sources = listSources('src/cli').map(toRepoPath);
    for (const verb of VERBS) {
      expect(sources, `src/cli/${verb}.ts 不在扫描范围里`).toContain(`src/cli/${verb}.ts`);
    }
    expect(sources).toContain('src/cli/index.ts');
    expect(sources.length).toBeGreaterThan(20);
  });

  it('反向验证：故意违规的合成源码必须被抓出来（护栏不是空话）', () => {
    const samples = [
      "await git(['push', 'origin', 'main']);",
      "execSync('git push origin main');",
      "await git(['commit', '-F', '-', '--no-verify']);",
      "await git(['rebase', '-i', 'HEAD~3']);",
      "await git(['reset', '--hard', 'HEAD~1']);",
      "await git(['checkout', 'main']);",
      "spawn('git', ['fetch', 'origin']);",
      ".option('--force-with-lease')",
      ".option('--force')",
    ];
    for (const sample of samples) {
      expect(findVerbViolations(sample), `漏抓：${sample}`).not.toEqual([]);
    }
  });

  it('不误报：数组 push / fs 的 force 选项 / 只读 git 调用都不算违规', () => {
    const innocent = [
      'entries.push(value);',
      'const merged = [...global]; merged.push(prefix);',
      'await rm(probe, { force: true });',
      "await git(['diff', '--staged', '--name-only']);",
      "await git(['commit', '-F', '-'], message.text);",
      "log('Windows: https://git-scm.com/download/win');",
      ".option('-f, --force', t().cli.init.force)",
      '// 注释里写 git push 也不算（先剥注释再判定）',
    ];
    for (const sample of innocent) {
      expect(findVerbViolations(sample), `误报：${sample}`).toEqual([]);
    }
  });

  it('唯一的 `--force` 豁免就是 init 的文件覆盖开关（新增一个就红）', () => {
    const index = stripComments(readFileSync(path.join(ROOT, 'src/cli/index.ts'), 'utf8'));
    const lines = index.split('\n');
    const forceLines = lines.filter((line) => line.includes('--force'));
    expect(forceLines).toHaveLength(1);
    expect(forceLines[0]).toContain(FORCE_ALLOWLIST_FRAGMENT);
    // 并且它必须挂在 `init` 命令块里（往上找最近的 `.command(` 行）
    const position = lines.findIndex((line) => line.includes('--force'));
    const ownerCommand = lines
      .slice(0, position)
      .reverse()
      .find((line) => line.includes('.command('));
    expect(ownerCommand, '`--force` 所在命令块找不到').toBeDefined();
    expect(ownerCommand).toContain("command('init')");
  });
});

// ── 护栏二：不重复（G6 薄包装）────────────────────────────────

describe('护栏二：薄包装，不重复造轮子（G6）', () => {
  it('commit.ts 依赖 check.ts 的 runCheck（体检绝不自己跑）', () => {
    const source = stripComments(readFileSync(path.join(ROOT, 'src/cli/commit.ts'), 'utf8'));
    // 依赖真实存在
    expect(source).toContain("from './check'");
    expect(source).toContain('runCheck');
    // 缺省实现就是「调用 T15 的 runCheck」，不是另写一套调用
    expect(source).toContain('runCheck({ cwd: dir })');
    // 且它消费的是 check 的结构化结论（不是自己解析一段文本）
    expect(source).toContain('formatCheckReport');
  });

  it('4 个动词都不自带 verify 调用（execSync / npm run verify 一律禁止）', () => {
    for (const verb of VERBS) {
      const source = stripComments(readFileSync(path.join(ROOT, `src/cli/${verb}.ts`), 'utf8'));
      expect(source, `${verb}.ts 里出现了 execSync（自己起子进程 = 第二套链路）`).not.toContain(
        'execSync',
      );
      expect(source, `${verb}.ts 里出现了 'npm run verify'`).not.toContain('npm run verify');
    }
  });

  it('verify 分类器全项目只有一处（src/cli 里一个都不许有）', () => {
    const definers = listSources('src')
      .map(toRepoPath)
      .filter((rel) =>
        /function\s+parseVerify\w*/.test(readFileSync(path.join(ROOT, rel), 'utf8')),
      );
    // 这两处是 v5.0 之前就存在的分工：QA 报告解析 / self-heal 四段分类
    expect(definers).toEqual(['src/agents/qa.ts', 'src/loop/self-heal/classifier.ts']);
    for (const definer of definers) {
      expect(definer.startsWith('src/cli/'), `${definer} 在 CLI 层复制了 verify 解析`).toBe(false);
    }
  });

  it('四段失败摘要只从 error-summary 取（check 与 workflow 共用同一份）', () => {
    for (const rel of ['src/cli/check.ts', 'src/cli/workflow.ts']) {
      const source = stripComments(readFileSync(path.join(ROOT, rel), 'utf8'));
      expect(source, `${rel} 没有复用 src/utils/error-summary`).toContain(
        "from '../utils/error-summary'",
      );
      expect(source).toContain('extractErrorSummary');
    }
  });

  it('review.ts 复用既有 reviewer 引擎（无第二套审查/渲染）', () => {
    const source = stripComments(readFileSync(path.join(ROOT, 'src/cli/review.ts'), 'utf8'));
    expect(source).toContain('ReviewerEngine.formatReport');
    expect(source).toContain('autoFix');
    for (const forbidden of [
      'createReviewAgents',
      'parseReviewOutput',
      'runAutoFix',
      'dedupAndSort',
    ]) {
      expect(source, `review.ts 里出现 ${forbidden}（第二套审查逻辑）`).not.toContain(forbidden);
    }
  });

  it('fix.ts 复用既有 self-heal 闭环（无第二套分类/修复）', () => {
    const source = stripComments(readFileSync(path.join(ROOT, 'src/cli/fix.ts'), 'utf8'));
    expect(source).toContain('runSelfHeal');
    expect(source).toContain("from '../loop/self-heal'");
    for (const forbidden of ['function classify', 'function strategyFor', 'function runSelfHeal']) {
      expect(source, `fix.ts 里出现 ${forbidden}（第二套闭环）`).not.toContain(forbidden);
    }
  });
});

// ── 护栏三：四动词都已注册（与 help.test.ts 的首屏断言互为表里）──────

describe('护栏三：四动词在 CLI 入口注册齐全', () => {
  it('四个动词都注册，且 review 已进「常用命令」顺序表', () => {
    const source = readFileSync(path.join(ROOT, 'src/cli/index.ts'), 'utf8');
    for (const verb of VERBS) {
      expect(source, `${verb} 没有在 CLI 入口注册`).toContain(`.command('${verb}`);
    }
    // 顺序表里的每一项都必须真的注册过（不打空头支票）——精确到数组内部
    const order = /const COMMON_COMMAND_ORDER: readonly string\[\] = \[([\s\S]*?)\];/.exec(source);
    expect(order).not.toBeNull();
    const names = [...(order?.[1] ?? '').matchAll(/'([a-z][a-z-]*)'/g)].map((m) => m[1]);
    for (const verb of VERBS) {
      expect(names, `${verb} 没进 COMMON_COMMAND_ORDER（首屏看不到它）`).toContain(verb);
    }
    for (const name of names) {
      expect(name, `顺序表里的 ${name} 没有注册（空头支票）`).toBeDefined();
      expect(source).toContain(`.command('${name}`);
    }
  });
});
