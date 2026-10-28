/**
 * `concertoai review` 测试（v5.0 M4 / T18）。
 *
 * ## 这个命令最危险的失败，不是「审查结论不好」
 *
 * 是**说了两套话**与**拿错退出码**：
 * - CLI 与 TUI 各渲染一套 → 用户按 CLI 的结论提交、按 TUI 的结论回滚（同一份代码两个答案）；
 * - `--fix` 被读成「它会改 critical」→ 用户批准了一堆自己没预期的写盘；
 * - 判不了（非仓库 / 没装 git / 缺 Key）却退出 0 → CI 绿灯放过没审过的代码。
 *
 * 所以用例按五条线写：
 * 1. **一致性（发布门）**：CLI 输出的**共享区块**必须与 `ReviewerEngine.formatReport`
 *    （TUI `/review` 用的那一个）逐行相等，且追加区块只能是「9 维分级 + 结论」；
 * 2. **退出码语义**：有 A 级（🔴 critical）→ 1；没有 → 0；判不了 → 1（绝不冒充通过）；
 * 3. **--fix 只修可自动修的那类**，写盘前必审批，非交互终端一个字节都不写；
 * 4. **薄包装（G6）**：源码里没有第二套维度提示词 / 问题解析 / 渲染器；
 * 5. **边缘路径四覆盖**：① 首次（非仓库 / 无改动）② 失败后恢复（git 失败后给路径）
 *    ③ 主动退出（Ctrl+C → 不写盘）④ 输出超长截断（改动文件数 / 每维证据数）。
 *
 * git 与审查引擎全部注入假实现：测试**绝不真跑 git**、**绝不调模型**、不写真实仓库。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  countGrades,
  formatDimensionOverview,
  formatInvalidSeverity,
  formatReviewVerdict,
  type GitNameLister,
  MAX_EVIDENCE_PER_DIMENSION,
  MAX_REVIEW_FILES,
  parseReviewSeverity,
  type ReviewEngineLike,
  resolveReviewScope,
  reviewExitCode,
  runReviewCommand,
} from '../../src/cli/review';
import { setLocale } from '../../src/i18n';
import { zh } from '../../src/i18n/zh';
import {
  ALL_DIMENSIONS,
  type AutoFixOptions,
  type ReviewDimension,
  ReviewerEngine,
  type ReviewIssue,
  type ReviewOptions,
  type ReviewReport,
} from '../../src/reviewer';
import type { ApprovalRequest } from '../../src/tools/registry';

// ── 假 git / 假引擎 ───────────────────────────────────────────

/** 假 git 状态（默认：有改动的仓库）。 */
interface FakeGitState {
  /** 命令退出码非 0。 */
  ok?: boolean;
  stderr?: string;
  /** 工作区改动。 */
  unstaged?: string[];
  /** 暂存区改动。 */
  staged?: string[];
  /** 未跟踪文件。 */
  untracked?: string[];
}

/** 假 git 句柄（`calls` 供「只读子命令」核对）。 */
interface FakeGit {
  list: GitNameLister;
  calls: string[][];
}

/** 构造假 git：只答三种「列文件名」查询，其他一律失败（真实现里也不该有别的）。 */
function fakeGit(state: FakeGitState = {}): FakeGit {
  const calls: string[][] = [];
  const ok = state.ok ?? true;
  const list: GitNameLister = async (_cwd, args) => {
    calls.push(args);
    if (!ok) {
      return { ok: false, stdout: '', stderr: state.stderr ?? 'fatal: not a git repository' };
    }
    const flat = args.join(' ');
    if (flat === 'diff --name-only') {
      return { ok: true, stdout: (state.unstaged ?? []).join('\n'), stderr: '' };
    }
    if (flat === 'diff --staged --name-only') {
      return { ok: true, stdout: (state.staged ?? []).join('\n'), stderr: '' };
    }
    if (flat === 'ls-files --others --exclude-standard') {
      return { ok: true, stdout: (state.untracked ?? []).join('\n'), stderr: '' };
    }
    return { ok: false, stdout: '', stderr: `unexpected git call: ${flat}` };
  };
  return { list, calls };
}

/** 假审查引擎：记录收到的 options，返回预设报告。 */
interface FakeEngine {
  engine: ReviewEngineLike;
  reviewCalls: ReviewOptions[];
  fixCalls: AutoFixOptions[];
}

function fakeEngine(report: ReviewReport, fixedReport?: ReviewReport): FakeEngine {
  const reviewCalls: ReviewOptions[] = [];
  const fixCalls: AutoFixOptions[] = [];
  const engine: ReviewEngineLike = {
    async review(options: ReviewOptions): Promise<ReviewReport> {
      reviewCalls.push(options);
      return report;
    },
    async autoFix(_report: ReviewReport, options: AutoFixOptions) {
      fixCalls.push(options);
      return {
        report: fixedReport ?? report,
        fixed: fixedReport?.fixResult?.fixed ?? 0,
        rolledBack: false,
        manual: fixedReport?.fixResult?.manual ?? 0,
      };
    },
  };
  return { engine, reviewCalls, fixCalls };
}

/** 报告构造（9 维汇总齐全，避免下游读 `summary[dim]` 崩）。 */
function makeReport(issues: ReviewIssue[] = []): ReviewReport {
  const summary = {} as ReviewReport['summary'];
  for (const dimension of ALL_DIMENSIONS) {
    summary[dimension] = { critical: 0, medium: 0, suggestion: 0 };
  }
  for (const issue of issues) {
    summary[issue.dimension][issue.severity] += 1;
  }
  return {
    scope: 'src/a.ts',
    timestamp: '2026-10-28T00:00:00.000Z',
    testPassed: true,
    issues,
    summary,
    durationMs: 12,
  };
}

/** 单条问题。 */
function issue(
  severity: ReviewIssue['severity'],
  overrides: Partial<ReviewIssue> = {},
): ReviewIssue {
  return {
    dimension: 'types',
    severity,
    file: 'src/a.ts',
    line: 42,
    title: `${severity} 问题`,
    description: '描述',
    ...overrides,
  };
}

// ── 收集输出 ──────────────────────────────────────────────────

/** 一次运行的可断言上下文。 */
interface RunContext {
  lines: string[];
  errLines: string[];
  /** stdout 全文。 */
  text: () => string;
  run: () => Promise<number>;
}

function harness(params: {
  /** 工作目录（缺省 = 本仓库根；`resolveReviewScope` 会按它校验文件是否存在）。 */
  cwd?: string;
  git?: FakeGit;
  engine?: ReviewEngineLike;
  report?: ReviewReport;
  args?: {
    path?: string;
    fix?: boolean;
    severity?: string;
    isTTY?: boolean;
    apiKey?: string;
    requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
    runVerify?: () => Promise<{ passed: boolean }>;
    ask?: (question: string) => Promise<string | undefined>;
  };
}): RunContext {
  const lines: string[] = [];
  const errLines: string[] = [];
  // 缺省「有一个真实存在的改动文件」：`resolveReviewScope` 会按磁盘存在性过滤，
  // 拿一个不存在的假路径当默认值会让整批用例静默走到「没有可审查的改动」。
  const git = params.git ?? fakeGit({ unstaged: ['src/cli/review.ts'] });
  const fake = params.engine === undefined ? fakeEngine(params.report ?? makeReport()) : undefined;
  const engine = params.engine ?? (fake as FakeEngine).engine;
  const args = params.args ?? {};
  const run = (): Promise<number> =>
    runReviewCommand({
      cwd: params.cwd ?? process.cwd(),
      ...(args.path !== undefined ? { path: args.path } : {}),
      ...(args.fix !== undefined ? { fix: args.fix } : {}),
      ...(args.severity !== undefined ? { severity: args.severity } : {}),
      ...(args.isTTY !== undefined ? { isTTY: args.isTTY } : {}),
      ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
      ...(args.requestApproval !== undefined ? { requestApproval: args.requestApproval } : {}),
      ...(args.runVerify !== undefined ? { runVerify: args.runVerify } : {}),
      ...(args.ask !== undefined ? { ask: args.ask } : {}),
      runGit: git.list,
      engine,
      log: (line) => lines.push(line),
      logErr: (line) => errLines.push(line),
    });
  return { lines, errLines, text: () => lines.join('\n'), run };
}

// ── 参数解析 ──────────────────────────────────────────────────

describe('parseReviewSeverity', () => {
  it('缺省 / 空串 → undefined（引擎按 normal，与 TUI 一致）', () => {
    expect(parseReviewSeverity(undefined)).toEqual({ ok: true });
    expect(parseReviewSeverity('  ')).toEqual({ ok: true });
  });

  it('三档合法值原样透传', () => {
    expect(parseReviewSeverity('strict')).toEqual({ ok: true, severity: 'strict' });
    expect(parseReviewSeverity('normal')).toEqual({ ok: true, severity: 'normal' });
    expect(parseReviewSeverity('lenient')).toEqual({ ok: true, severity: 'lenient' });
  });

  it('非法值 → ok:false 且带回原值（供报错）', () => {
    expect(parseReviewSeverity('bogus')).toEqual({ ok: false, value: 'bogus' });
  });

  it('formatInvalidSeverity 的合法值清单来自 REVIEW_SEVERITIES（只有一处）', () => {
    const message = formatInvalidSeverity('bogus');
    expect(message).toContain('bogus');
    for (const value of ['strict', 'normal', 'lenient']) {
      expect(message).toContain(value);
    }
  });
});

// ── 审查范围（默认 = git 改动的文件）─────────────────────────

describe('resolveReviewScope（默认审 git 改动文件）', () => {
  let tmp: string;
  /** 本 describe 造过的全部临时目录（每个用例一个，统一在 afterAll 清干净）。 */
  const created: string[] = [];

  beforeEach(async () => {
    setLocale('zh');
    tmp = await mkdtemp(path.join(os.tmpdir(), 'concertoai-review-scope-'));
    created.push(tmp);
  });

  afterAll(async () => {
    // 逐个删、带重试（Windows EBUSY）；删不掉就如实抛，不静默留垃圾（AGENTS 第 17 条）
    for (const dir of created) {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  /** 在临时目录里造真实文件（`resolveReviewScope` 会过滤掉磁盘上不存在的路径）。 */
  async function touch(...files: string[]): Promise<void> {
    for (const file of files) {
      const absolute = path.join(tmp, file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, '// x\n', 'utf8');
    }
  }

  it('给了 path → given（不查 git）', async () => {
    const git = fakeGit();
    const scope = await resolveReviewScope({ cwd: tmp, given: 'src/a.ts', listGit: git.list });
    expect(scope).toEqual({ kind: 'given', paths: ['src/a.ts'] });
    expect(git.calls).toEqual([]);
  });

  it('工作区 + 暂存区 + 未跟踪三路合并去重（已 add 的改动也要审）', async () => {
    await touch('src/a.ts', 'src/b.ts', 'src/c.ts');
    const git = fakeGit({
      unstaged: ['src/a.ts'],
      staged: ['src/a.ts', 'src/b.ts'],
      untracked: ['src/c.ts'],
    });
    const scope = await resolveReviewScope({ cwd: tmp, listGit: git.list });
    expect(scope).toEqual({
      kind: 'changed',
      paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      total: 3,
    });
  });

  it('排除 node_modules / dist；已删除（磁盘不存在）的文件不审', async () => {
    await touch('src/keep.ts');
    const git = fakeGit({
      unstaged: ['node_modules/pkg/index.js', 'dist/out.js', 'src/deleted.ts', 'src/keep.ts'],
    });
    const scope = await resolveReviewScope({ cwd: tmp, listGit: git.list });
    expect(scope).toEqual({ kind: 'changed', paths: ['src/keep.ts'], total: 1 });
  });

  it('改动多于上限 → 截断并带回 total（输出超长截断，不静默丢）', async () => {
    const files = Array.from({ length: MAX_REVIEW_FILES + 5 }, (_, i) => `src/f${i}.ts`);
    await touch(...files);
    const scope = await resolveReviewScope({
      cwd: tmp,
      listGit: fakeGit({ unstaged: files }).list,
    });
    expect(scope.kind).toBe('changed');
    if (scope.kind === 'changed') {
      expect(scope.paths.length).toBe(MAX_REVIEW_FILES);
      expect(scope.total).toBe(MAX_REVIEW_FILES + 5);
    }
  });

  it('无改动 → empty（不是「审完没问题」）', async () => {
    const scope = await resolveReviewScope({ cwd: tmp, listGit: fakeGit().list });
    expect(scope).toEqual({ kind: 'empty' });
  });

  it('非仓库 / git 没装 → 分别如实回报（不冒充通过）', async () => {
    const notRepo = await resolveReviewScope({
      cwd: tmp,
      listGit: fakeGit({ ok: false, stderr: 'fatal: not a git repository' }).list,
    });
    expect(notRepo).toEqual({ kind: 'not-repo' });
    const missing = await resolveReviewScope({
      cwd: tmp,
      listGit: fakeGit({ ok: false, stderr: 'spawn git ENOENT' }).list,
    });
    expect(missing).toEqual({ kind: 'git-missing' });
  });
});

// ── 分级与退出码 ──────────────────────────────────────────────

describe('分级与退出码', () => {
  it('countGrades：A = 严重 / B = 中等 / C = 建议', () => {
    const report = makeReport([
      issue('critical'),
      issue('medium'),
      issue('suggestion'),
      issue('suggestion'),
    ]);
    expect(countGrades(report)).toEqual({ A: 1, B: 1, C: 2 });
  });

  it('退出码：有 A 级 → 1；只有 B / C → 0；无问题 → 0', () => {
    expect(reviewExitCode(makeReport([issue('critical')]))).toBe(1);
    expect(reviewExitCode(makeReport([issue('medium'), issue('suggestion')]))).toBe(0);
    expect(reviewExitCode(makeReport())).toBe(0);
  });

  it('9 维分级表：每维一行，证据带 `文件:行号`，每维最多 3 条', () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      issue('medium', { dimension: 'style', file: 'src/s.ts', line: i + 1 }),
    );
    const lines = formatDimensionOverview(makeReport(issues));
    expect(lines[0]).toBe(zh.review.gradingTitle);
    expect(lines.length).toBe(1 + ALL_DIMENSIONS.length);
    const styleLine = lines.find((line) => line.includes('style'));
    expect(styleLine).toContain('src/s.ts:1');
    expect(styleLine).toContain(`等 ${5 - MAX_EVIDENCE_PER_DIMENSION} 处`);
    expect(styleLine).not.toContain('src/s.ts:5');
    // 9 个维度一个都不能少（没有问题的维度也要出现，不能只列命中的）
    for (const dimension of ALL_DIMENSIONS) {
      expect(
        lines.some((line) => line.includes(dimension)),
        `${dimension} 维度没出现在分级表`,
      ).toBe(true);
    }
  });

  it('结论：无 A 级说「可以继续」，有 A 级说「先修」（退出码写在文案里）', () => {
    const clean = formatReviewVerdict(makeReport([issue('medium')]));
    expect(clean[0]).toBe(zh.review.conclusionClean);
    expect(clean.join('\n')).toContain('退出码 0');

    const blocked = formatReviewVerdict(makeReport([issue('critical'), issue('critical')]));
    expect(blocked[0]).toBe(zh.review.conclusionBlocked.replace('{count}', '2'));
    expect(blocked.join('\n')).toContain('退出码 1');
  });
});

// ── 主流程：输出与 TUI 一致（发布门一致性门）──────────────────

describe('主流程（默认审 git 改动文件）', () => {
  beforeEach(() => {
    setLocale('zh');
  });

  it('退出码 0：只有 B / C 级问题', async () => {
    const ctx = harness({
      git: fakeGit({ unstaged: ['src/cli/review.ts'] }),
      report: makeReport([issue('medium')]),
    });
    expect(await ctx.run()).toBe(0);
    expect(ctx.text()).toContain(zh.review.conclusionClean);
  });

  it('退出码 1：存在 A 级（严重）问题 → 「先修再提交」', async () => {
    const ctx = harness({ report: makeReport([issue('critical')]) });
    expect(await ctx.run()).toBe(1);
    expect(ctx.text()).toContain(zh.review.conclusionBlocked.replace('{count}', '1'));
  });

  it('一致性：共享区块与 TUI `/review` 的 formatReport 逐行相等，追加区块只有两块', async () => {
    const report = makeReport([
      issue('critical', { dimension: 'security', file: 'src/auth.ts', line: 7 }),
      issue('suggestion', { dimension: 'docs', file: 'README.md', line: 3 }),
    ]);
    const ctx = harness({ report });
    await ctx.run();
    const shared = ReviewerEngine.formatReport(report).split('\n');
    // 输出分三块：① 范围提示（CLI 专属）② 共享报告（与 TUI 逐字节一致）③ 9 维分级 + 结论
    const start = ctx.lines.indexOf(shared[0] as string);
    expect(start).toBeGreaterThanOrEqual(0);
    // ① 范围提示只能是那几种「审什么」的句子（别的都不许插到报告前面）
    const preamble = ctx.lines.slice(0, start);
    expect(preamble.length).toBeGreaterThan(0);
    for (const line of preamble) {
      expect(
        line.startsWith(zh.review.scopeChanged.slice(0, 4)) ||
          line.startsWith(zh.review.scopeGiven.slice(0, 4)) ||
          line.startsWith('  …'),
        `报告前出现了非范围提示的行：${line}`,
      ).toBe(true);
    }
    // ② 共享区块逐行相等（一个字都不许改——TUI 的 /review 输出的就是这一段）
    expect(ctx.lines.slice(start, start + shared.length)).toEqual(shared);
    // ③ 追加区块只能是「9 维分级 + 结论」（结构固定，顺序固定）
    expect(ctx.lines.slice(start + shared.length)).toEqual([
      '',
      ...formatDimensionOverview(report),
      '',
      ...formatReviewVerdict(report),
    ]);
  });

  it('一致性：两侧渲染器是同一个函数 + scope 形状与 TUI 映射一致（源码级）', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cliSource = await readFile(path.join(here, '../../src/cli/review.ts'), 'utf8');
    const tuiSource = await readFile(path.join(here, '../../src/ui/App.tsx'), 'utf8');
    // 同一个渲染器（TUI 在 App.tsx 里调的就是它）
    expect(cliSource).toContain('ReviewerEngine.formatReport');
    expect(tuiSource).toContain('ReviewerEngine.formatReport');
    // 同一个引擎构造方式
    expect(cliSource).toContain('new ReviewerEngine(');
    expect(tuiSource).toContain('new ReviewerEngine(');
    // 同一个 scope 形状：TUI 的 `/review <path>` 传的是 { type: 'files', paths }
    expect(tuiSource).toContain("{ type: 'files', paths: reviewCmd.paths }");
    expect(cliSource).toContain("{ type: 'files', paths: scope.paths }");
  });

  it('引擎收到的 options 与 TUI 同形：scope=files + severity 透传', async () => {
    const fake = fakeEngine(makeReport());
    const ctx = harness({
      engine: fake.engine,
      // 用仓库里真实存在的两个文件（范围解析会按磁盘存在性过滤）
      git: fakeGit({ unstaged: ['src/cli/review.ts'], staged: ['src/cli/check.ts'] }),
      args: { severity: 'strict' },
    });
    await ctx.run();
    expect(fake.reviewCalls).toHaveLength(1);
    expect(fake.reviewCalls[0]).toEqual({
      scope: { type: 'files', paths: ['src/cli/check.ts', 'src/cli/review.ts'] },
      severity: 'strict',
    });
  });

  it('显式 path：scope 只含该路径，且提示语说的是给定路径', async () => {
    const fake = fakeEngine(makeReport());
    const ctx = harness({ engine: fake.engine, args: { path: 'src/cli/review.ts' } });
    await ctx.run();
    expect(fake.reviewCalls[0]?.scope).toEqual({ type: 'files', paths: ['src/cli/review.ts'] });
    expect(ctx.text()).toContain(zh.review.scopeGiven.replace('{path}', 'src/cli/review.ts'));
  });

  it('改动超过上限 → 打印截断提示（不静默丢掉剩下的文件）', async () => {
    // 隔离临时目录造 N 个真实文件（不在本仓库里造垃圾）
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'concertoai-review-trunc-'));
    try {
      const files = Array.from({ length: MAX_REVIEW_FILES + 2 }, (_, i) => `src/f${i}.ts`);
      for (const file of files) {
        const absolute = path.join(tmp, file);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, '// x\n', 'utf8');
      }
      const ctx = harness({ cwd: tmp, git: fakeGit({ unstaged: files }) });
      await ctx.run();
      expect(ctx.text()).toContain(
        zh.review.scopeTruncated
          .replace('{count}', '2')
          .replace('{limit}', String(MAX_REVIEW_FILES)),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

// ── 边缘路径（G5 四覆盖）─────────────────────────────────────

describe('边缘路径（G5 四覆盖）', () => {
  beforeEach(() => {
    setLocale('zh');
  });

  it('① 首次：非 git 仓库 → 明确提示指定路径，退出码 1（不冒充通过）', async () => {
    const ctx = harness({ git: fakeGit({ ok: false, stderr: 'fatal: not a git repository' }) });
    expect(await ctx.run()).toBe(1);
    expect(ctx.text()).toContain(zh.review.notRepo);
    expect(ctx.text()).toContain(zh.review.notRepoHint);
  });

  it('① 首次：git 没装 → 给出安装指引 + 备选做法', async () => {
    const ctx = harness({ git: fakeGit({ ok: false, stderr: 'spawn git ENOENT' }) });
    expect(await ctx.run()).toBe(1);
    expect(ctx.text()).toContain(zh.review.gitMissing);
    expect(ctx.text()).toContain('git-scm.com');
  });

  it('① 首次：没有改动 → 说清「没得审」，退出码 0（不是失败）', async () => {
    const ctx = harness({ git: fakeGit() });
    expect(await ctx.run()).toBe(0);
    expect(ctx.text()).toContain(zh.review.noChanges);
    expect(ctx.text()).toContain('concertoai review <文件或目录>');
  });

  it('② 失败后恢复：git 判不了时给 path 仍能审（同一进程外的下一步）', async () => {
    const git = fakeGit({ ok: false, stderr: 'fatal: not a git repository' });
    const fake = fakeEngine(makeReport());
    const ctx = harness({ engine: fake.engine, git, args: { path: 'src/' } });
    expect(await ctx.run()).toBe(0);
    expect(fake.reviewCalls[0]?.scope).toEqual({ type: 'files', paths: ['src/'] });
  });

  it('③ 非法 severity → 一条都不审，退出码 1，列出合法值', async () => {
    const fake = fakeEngine(makeReport());
    const ctx = harness({ engine: fake.engine, args: { severity: 'strictest' } });
    expect(await ctx.run()).toBe(1);
    expect(fake.reviewCalls).toHaveLength(0);
    expect(ctx.text()).toContain('strictest');
    expect(ctx.text()).toContain('strict / normal / lenient');
  });

  it('③ 缺 Key 且无注入引擎 → 说清要 Key，退出码 1（不假审查）', async () => {
    const lines: string[] = [];
    const code = await runReviewCommand({
      cwd: process.cwd(),
      runGit: fakeGit({ unstaged: ['src/cli/review.ts'] }).list,
      log: (line) => lines.push(line),
      logErr: () => {},
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(zh.review.needsApiKey);
    expect(lines.join('\n')).toContain('DEEPSEEK_API_KEY');
  });

  it('④ 证据超长：每维只展示前 3 条（输出不淹没终端）', () => {
    const issues = Array.from({ length: 9 }, (_, i) =>
      issue('critical', {
        dimension: 'security' as ReviewDimension,
        file: 'src/x.ts',
        line: i + 1,
      }),
    );
    const overview = formatDimensionOverview(makeReport(issues)).join('\n');
    expect(overview).toContain('src/x.ts:1');
    expect(overview).toContain('src/x.ts:3');
    expect(overview).not.toContain('src/x.ts:4');
    expect(overview).toContain('等 6 处');
  });
});

// ── --fix（只修可自动修的那类，写盘必审批）─────────────────────

describe('--fix', () => {
  beforeEach(() => {
    setLocale('zh');
  });

  it('修的是「可自动修的问题（建议级）」——文案不许让人以为它改 critical', () => {
    // 两个「A」撞车的护栏：修复范围文案必须说「建议级」，且不能说「严重级也修」
    expect(zh.review.fixScope).toContain('建议级');
    expect(zh.review.fixScope).not.toContain('严重级');
    expect(zh.review.fixScope).toContain('严重 / 中等级一律转人工');
  });

  it('有可自动修问题 + 非 TTY → 一个字节都不写（不调 autoFix）', async () => {
    const fake = fakeEngine(makeReport([issue('suggestion')]));
    const ctx = harness({
      engine: fake.engine,
      report: makeReport([issue('suggestion')]),
      args: { fix: true, isTTY: false },
    });
    expect(await ctx.run()).toBe(0);
    expect(fake.fixCalls).toHaveLength(0);
    expect(ctx.text()).toContain(zh.review.fixNeedsTty);
  });

  it('没有可自动修的问题（只有 critical）→ 不动手，直接说明', async () => {
    const fake = fakeEngine(makeReport([issue('critical')]));
    const ctx = harness({
      engine: fake.engine,
      report: makeReport([issue('critical')]),
      args: { fix: true, isTTY: true },
    });
    expect(await ctx.run()).toBe(1);
    expect(fake.fixCalls).toHaveLength(0);
    expect(ctx.text()).toContain(zh.review.fixNoAuto);
  });

  it('批准后：把审批/体检/快照全部交给既有 autofix，并渲染「修复结果」区块', async () => {
    const base = makeReport([issue('suggestion', { file: 'src/a.ts', line: 3 })]);
    const fixed = makeReport([issue('suggestion', { file: 'src/a.ts', line: 3 })]);
    fixed.fixResult = {
      fixed: 1,
      manual: 0,
      rolledBack: 0,
      items: [{ issue: fixed.issues[0] as ReviewIssue, category: 'A', status: 'fixed' }],
    };
    const fake = fakeEngine(base, fixed);
    const approvals: ApprovalRequest[] = [];
    const ctx = harness({
      engine: fake.engine,
      report: base,
      args: {
        fix: true,
        isTTY: true,
        requestApproval: (request) => {
          approvals.push(request);
          return true;
        },
        runVerify: async () => ({ passed: true }),
      },
    });
    expect(await ctx.run()).toBe(0);
    expect(fake.fixCalls).toHaveLength(1);
    const fixOptions = fake.fixCalls[0] as AutoFixOptions;
    // 审批 / 体检 / 快照三项都在（缺一项就等于「写盘没人管」或「修坏了不复验」）
    expect(typeof fixOptions.requestApproval).toBe('function');
    expect(typeof fixOptions.runVerify).toBe('function');
    expect(fixOptions.snapshots).toBeDefined();
    expect(fixOptions.onProgress).toBeDefined();
    // 「修复结果」区块走共享渲染器（TUI 里同一段）
    expect(ctx.text()).toContain(zh.reviewer.fixResultTitle);
    expect(ctx.text()).toContain(
      zh.review.fixDone
        .replace('{fixed}', '1')
        .replace('{manual}', '0')
        .replace('{rolledBack}', '0'),
    );
    // CLI 自己不去调审批——审批权在 autofix 里（本命令只提供「怎么问」）
    expect(approvals).toHaveLength(0);
  });

  it('Ctrl+C（ask 返回 undefined）→ 审批回调判否，修复不写盘', async () => {
    const base = makeReport([issue('suggestion')]);
    const fake = fakeEngine(base);
    const ctx = harness({
      engine: fake.engine,
      report: base,
      args: { fix: true, isTTY: true, ask: async () => undefined },
    });
    await ctx.run();
    const fixOptions = fake.fixCalls[0] as AutoFixOptions;
    const approve = fixOptions.requestApproval as (
      request: ApprovalRequest,
    ) => Promise<boolean> | boolean;
    // 真实的 autofix 会拿这个回调问一次；Ctrl+C / 空回答一律当拒绝（fail-closed）
    expect(await approve({ kind: 'edit', summary: 'x', detail: 'y' })).toBe(false);
  });
});

// ── 薄包装护栏（G6）──────────────────────────────────────────

describe('薄包装护栏（G6：无第二套审查解析）', () => {
  it('review.ts 复用 reviewer 引擎：只有调用，没有第二套提示词/解析/渲染', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await readFile(path.join(here, '../../src/cli/review.ts'), 'utf8');
    // 正向：三件套都来自 reviewer
    expect(source).toContain("from '../reviewer'");
    expect(source).toContain('ReviewerEngine.formatReport');
    expect(source).toContain('autoFix');
    // 反向：引擎内部的东西一个都不许在本文件里重造
    expect(source).not.toContain('createReviewAgents');
    expect(source).not.toContain('parseReviewOutput');
    expect(source).not.toContain('SEVERITY_ORDER');
    expect(source).not.toContain('dedupAndSort');
    expect(source).not.toContain('runAutoFix');
    // 也不许自己起子进程跑 verify / lint（体检只有一处来源：check.ts）
    expect(source).not.toContain('execSync');
    expect(source).not.toContain('npm run verify');
  });
});
