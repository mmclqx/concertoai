/**
 * `concertoai review` 命令（v5.0 M4 / T18）：CLI 层直达 9 维审查。
 *
 * ## 它回答一个问题
 *
 * 「这份改动，值不值得我按下一次提交？」——TUI 里早就有 `/review`（5 个审查子代理
 * 并行跑 9 个维度），但只有进了 chat 才够得着。本命令是**同一台引擎的第二扇门**：
 * `concertoai review`（默认审 git 改动文件）/ `review <path>` / `--severity` / `--fix`。
 *
 * ## 五条不可妥协的边界
 *
 * 1. **薄包装（G6，专家点名）**：审查**只**调 `ReviewerEngine.review`，渲染**只**调
 *    `ReviewerEngine.formatReport`（与 TUI 的 `/review` 逐字节同一份输出），自动修复
 *    **只**调 `ReviewerEngine.autoFix`（A/B 分批 / 批量审批 / 快照 / 增量体检 / 回滚都在
 *    `src/reviewer/autofix.ts` 里）。本文件里**没有**第二套维度提示词、没有第二套问题解析、
 *    没有第二套渲染器——双份实现 = 两份结论（v4.1.1「装好却跑不通」的同类分叉）。
 * 2. **输出与 TUI 一致（发布门一致性门）**：先原样打印 `ReviewerEngine.formatReport(report)`，
 *    再追加 CLI 专属的两块（9 维分级表 + 退出码结论）。测试断言「前三块与 TUI 逐行相等」，
 *    追加部分只能是这两块——**共享区块一个字都不许改**。
 * 3. **退出码唯一语义**：`0 = 没有 A 级（🔴 严重）问题`，`1 = 有 A 级`（含「判不了」：
 *    非 git 仓库 / git 没装 / 缺 Key）。**判不了绝不冒充通过**（T15 假通过教训）。
 * 4. **`--fix` 只修「可自动修」的那一类，且每次写盘都审批**：分批规则来自
 *    `categorizeIssue`（🟢 建议级且能定位文件 = 可自动修），严重 / 中等级**一律转人工**；
 *    非交互终端无法审批 → 一个字节都不写（fail-closed，与 `fix` / `commit` 同口径）。
 * 5. **只读默认**：不带 `--fix` 时本命令零写入——不写盘、不建快照、不改配置。
 *
 * ## 两个「A」为什么必须叫清
 *
 * 本项目里有两个都叫 A 的东西，撞车会读错：
 * - **严重程度 A**（= 🔴 critical）：决定退出码，「A 级存在 = 不许合」；
 * - **修复批次 A**（= `autofix` 的 `categorizeIssue(issue) === 'A'`）：决定 `--fix` 修哪些，
 *   实际是「🟢 建议级 + 能定位文件」（可自动修），与严重程度**不是同一维度**。
 *
 * 所以 CLI 用户文案里一律用「A 级（严重）」和「可自动修的问题（建议级）」两个完整说法，
 * 不写裸「A 类」。`--fix` 的语义因此不可能被读成「它会去改 critical」——这条由
 * `tests/cli/review.test.ts` 的文案断言盯着（断言 `fixScope` 文案含「建议级」且不含「严重级」）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { SubagentSpawner } from '../agent/spawner';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
import { DeepSeekClient, type ModelClient } from '../model/client';
import { SnapshotManager } from '../orchestrator/transaction';
import {
  ALL_DIMENSIONS,
  type AutoFixOptions,
  REVIEW_SEVERITIES,
  ReviewerEngine,
  type ReviewOptions,
  type ReviewReport,
  type ReviewSeverity,
  type Severity,
} from '../reviewer';
import type { ApprovalRequest } from '../tools/registry';
import { runCheck } from './check';
import { resolveModel } from './common';
import { promptLine } from './prompt';

// ── 常量 ──────────────────────────────────────────────────────

/**
 * 一次最多审多少个改动文件（G5 边缘路径④：超长改动清单不淹没 prompt 与终端）。
 *
 * 30 是「够覆盖一次正常提交、又不至于把改动清单塞爆子代理 prompt」的折中；
 * 超出部分**明确告知**（不静默丢），用户可显式传 path 分批审。
 */
export const MAX_REVIEW_FILES = 30;

/** 每个维度最多展示几处证据（`文件:行号`）。 */
export const MAX_EVIDENCE_PER_DIMENSION = 3;

/** 不纳入审查的目录（与 `impact-scan` / `project-scan` 同口径）。 */
export const REVIEW_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  'out',
];

// ── 分级（严重程度，不是修复批次）──────────────────────────────

/** 展示用分级：A = 严重 / B = 中等 / C = 建议（与 `Severity` 一一对应）。 */
export type ReviewGrade = 'A' | 'B' | 'C';

/** 严重程度 → 展示分级。 */
export const GRADE_OF_SEVERITY: Record<Severity, ReviewGrade> = {
  critical: 'A',
  medium: 'B',
  suggestion: 'C',
};

// ── 类型定义 ──────────────────────────────────────────────────

/** 一次 git 只读调用的结果（`ok` 看退出码）。 */
export interface GitNamesOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** git 只读执行器（只用来列文件名；测试注入假实现，绝不真跑 git）。 */
export type GitNameLister = (cwd: string, args: string[]) => Promise<GitNamesOutcome>;

/** 审查范围的解析结果（`kind` 决定提示语与退出码）。 */
export type ReviewScopeResolution =
  | { kind: 'given'; paths: string[] }
  | { kind: 'changed'; paths: string[]; total: number }
  | { kind: 'empty' }
  | { kind: 'not-repo' }
  | { kind: 'git-missing' };

/**
 * 审查引擎抽象（生产 = `ReviewerEngine`；测试注入假引擎）。
 *
 * 只声明本命令用到的两个方法——接口越小，越不容易在 CLI 侧偷偷长出第二套逻辑。
 */
export interface ReviewEngineLike {
  review(options: ReviewOptions): Promise<ReviewReport>;
  autoFix(
    report: ReviewReport,
    options: AutoFixOptions,
  ): Promise<{ report: ReviewReport; fixed: number; rolledBack: boolean; manual: number }>;
}

/** review 命令选项（引擎 / git / 审批 / 体检全部可注入，测试不跑真实审查与 git）。 */
export interface ReviewCommandOptions {
  /** 工作目录（默认 process.cwd()）。 */
  cwd?: string;
  /** 位置参数：要审查的文件或目录（缺省 = git 改动的文件）。 */
  path?: string;
  /** `--fix`：审查后自动修「可自动修的问题」（走审批）。 */
  fix?: boolean;
  /** `--severity`：审查阈值原文（strict / normal / lenient；非法值报错退出）。 */
  severity?: string;
  /** DeepSeek API Key（缺省且未注入引擎 → 明确提示需要 Key）。 */
  apiKey?: string;
  /** 模型 ID（缺省用默认模型）。 */
  model?: string;
  /** 界面语言。 */
  lang?: string;
  /** 是否交互式终端（缺省 `process.stdin.isTTY`；非 TTY 无法审批 → 不写盘）。 */
  isTTY?: boolean;
  /** 报告输出（stdout）。 */
  log?: (line: string) => void;
  /** 过程日志（stderr）。 */
  logErr?: (line: string) => void;
  /** 测试注入：git 只读执行器（缺省 spawn 真实 git）。 */
  runGit?: GitNameLister;
  /** 测试注入：审查引擎（缺省按 apiKey 构造 `ReviewerEngine`）。 */
  engine?: ReviewEngineLike;
  /** 测试注入：模型客户端（缺省按 apiKey 构造）。 */
  client?: ModelClient;
  /** 测试注入：`--fix` 的批量审批（缺省弹 y/N；非 TTY 一律拒绝）。 */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  /** 测试注入：修复后的增量体检（缺省复用 T15 的 `runCheck`）。 */
  runVerify?: () => Promise<{ passed: boolean }>;
  /** 测试注入：快照管理器（缺省 `new SnapshotManager(cwd)`）。 */
  snapshots?: SnapshotManager;
  /** 测试注入：读一行回答（缺省走 `promptLine`）。 */
  ask?: (question: string) => Promise<string | undefined>;
}

// ── 纯函数：参数与范围 ────────────────────────────────────────

/** 解析 `--severity`：缺省 → undefined（引擎按 normal）；非法值 → `{ ok: false }`。 */
export function parseReviewSeverity(
  raw: string | undefined,
): { ok: true; severity?: ReviewSeverity } | { ok: false; value: string } {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return { ok: true };
  }
  if (!REVIEW_SEVERITIES.includes(value as ReviewSeverity)) {
    return { ok: false, value };
  }
  return { ok: true, severity: value as ReviewSeverity };
}

/**
 * 非法 severity 的提示句。
 *
 * 合法值清单**只来自** `REVIEW_SEVERITIES`（reviewer 的类型定义处），CLI 入口与命令体
 * 都调这一个函数——不会出现「入口报一套合法值、命令体报另一套」的分叉。
 */
export function formatInvalidSeverity(value: string): string {
  return fmt(t().review.invalidSeverity, { value, values: REVIEW_SEVERITIES.join(' / ') });
}

/** 路径归一化为正斜杠（Windows 反斜杠不参与任何比较，AGENTS T8-W3 同口径）。 */
function normalizeRelPath(file: string): string {
  return file.split('\\').join('/').trim();
}

/** 是否落在排除目录里（按路径段判断，避免 `src/my-node_modules.ts` 被误排除）。 */
function isExcludedPath(relPath: string): boolean {
  const segments = relPath.toLowerCase().split('/');
  return segments.some((segment) => REVIEW_EXCLUDED_DIRS.includes(segment));
}

/** 按行切分 git 输出并归一化（丢空行）。 */
function splitGitPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map(normalizeRelPath)
    .filter((line) => line !== '');
}

/**
 * 解析审查范围（纯函数：git 执行由 `listGit` 注入）。
 *
 * 默认范围 = **改动文件**：工作区改动（`diff --name-only`）+ 暂存区改动
 * （`diff --staged --name-only`）+ 未跟踪新文件（`ls-files --others`）。
 *
 * 为什么三条都要：`concertoai review` 最典型的用法是「提交前审一眼」，此时改动已在
 * 暂存区；只看工作区 diff 会对**已经 add 完的改动视而不见**（那正是要提交的那批）。
 * 未跟踪新文件同理——刚写的新文件不在任何 diff 里，漏审等于最该看的东西没看。
 */
export async function resolveReviewScope(params: {
  cwd: string;
  /** 位置参数（给了就不查 git）。 */
  given?: string;
  listGit: GitNameLister;
}): Promise<ReviewScopeResolution> {
  const { cwd, given, listGit } = params;
  const trimmed = given?.trim();
  if (trimmed !== undefined && trimmed !== '') {
    return { kind: 'given', paths: [trimmed] };
  }

  const [unstaged, staged, untracked] = await Promise.all([
    listGit(cwd, ['diff', '--name-only']),
    listGit(cwd, ['diff', '--staged', '--name-only']),
    listGit(cwd, ['ls-files', '--others', '--exclude-standard']),
  ]);
  if (!unstaged.ok) {
    const stderr = `${unstaged.stderr}${unstaged.stdout}`;
    if (/ENOENT|not recognized|not found|command not found/i.test(stderr)) {
      return { kind: 'git-missing' };
    }
    return { kind: 'not-repo' };
  }

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const file of [
    ...splitGitPaths(unstaged.stdout),
    ...splitGitPaths(staged.stdout),
    ...splitGitPaths(untracked.stdout),
  ]) {
    const key = file.toLowerCase();
    if (seen.has(key) || isExcludedPath(file)) {
      continue;
    }
    // 已删除的文件没有内容可审（diff 里出现、磁盘上不存在）→ 跳过，不让子代理空跑
    if (!existsSync(path.join(cwd, file))) {
      continue;
    }
    seen.add(key);
    candidates.push(file);
  }
  if (candidates.length === 0) {
    return { kind: 'empty' };
  }
  candidates.sort((a, b) => a.localeCompare(b));
  return {
    kind: 'changed',
    paths: candidates.slice(0, MAX_REVIEW_FILES),
    total: candidates.length,
  };
}

// ── 纯函数：分级与结论 ────────────────────────────────────────

/** 统计 A / B / C 级问题数（A = 🔴 严重）。 */
export function countGrades(report: ReviewReport): Record<ReviewGrade, number> {
  const counts: Record<ReviewGrade, number> = { A: 0, B: 0, C: 0 };
  for (const issue of report.issues) {
    counts[GRADE_OF_SEVERITY[issue.severity]] += 1;
  }
  return counts;
}

/** 退出码：有 A 级（严重）问题 → 1；否则 0（「判不了」由调用方直接返回 1）。 */
export function reviewExitCode(report: ReviewReport): 0 | 1 {
  return report.issues.some((issue) => issue.severity === 'critical') ? 1 : 0;
}

/** 问题证据（`文件:行号`，无行号则只有文件）。 */
function evidenceOf(issue: ReviewReport['issues'][number]): string {
  return issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
}

/**
 * 9 维分级表（每维 A/B/C 计数 + 证据 `文件:行号`）。
 *
 * 这是 **CLI 专属**的一块（TUI 侧靠 `formatReport` 的汇总表），所以单独成函数，
 * 便于一致性测试把「共享区块」与「CLI 追加区块」分开断言。
 */
export function formatDimensionOverview(report: ReviewReport): string[] {
  const dict = t().review;
  const lines: string[] = [dict.gradingTitle];
  for (const dimension of ALL_DIMENSIONS) {
    const issues = report.issues.filter((issue) => issue.dimension === dimension);
    if (issues.length === 0) {
      lines.push(fmt(dict.dimLineEmpty, { dimension }));
      continue;
    }
    const counts: Record<ReviewGrade, number> = { A: 0, B: 0, C: 0 };
    for (const issue of issues) {
      counts[GRADE_OF_SEVERITY[issue.severity]] += 1;
    }
    const shown = issues.slice(0, MAX_EVIDENCE_PER_DIMENSION).map(evidenceOf);
    const hidden = issues.length - shown.length;
    const more = hidden > 0 ? fmt(dict.evidenceMore, { count: hidden }) : '';
    lines.push(
      fmt(dict.dimLine, {
        dimension,
        a: counts.A,
        b: counts.B,
        c: counts.C,
        evidence: fmt(dict.evidence, { locations: shown.join(' / '), more }),
      }),
    );
  }
  return lines;
}

/** 结论 + 下一步（CLI 专属；退出码语义在这里说清，别让用户去猜 0/1）。 */
export function formatReviewVerdict(report: ReviewReport): string[] {
  const dict = t().review;
  const counts = countGrades(report);
  const lines: string[] = [
    counts.A > 0 ? fmt(dict.conclusionBlocked, { count: counts.A }) : dict.conclusionClean,
  ];
  lines.push(dict.nextStep);
  return lines;
}

// ── git 只读执行层（可注入）─────────────────────────────────────

/**
 * 默认执行器：`spawn('git', args)`，只用来**列文件名**。
 *
 * 与 `commit` 的 runner 分开是有意的：`commit` 需要 stdin 传 message + 子命令白名单，
 * 本命令只需要「读名字」这一件事。两者都是本地只读调用，谁都不碰远程。
 */
export function createGitNameLister(): GitNameLister {
  return (cwd: string, args: string[]): Promise<GitNamesOutcome> =>
    new Promise((resolve) => {
      const child = spawn('git', args, { cwd, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      // git 没装 / 不在 PATH：spawn 直接报错，如实交给调用方判断
      child.on('error', (err: Error) => {
        resolve({ ok: false, stdout, stderr: `${stderr}${err.message}` });
      });
      child.on('close', (code: number | null) => {
        resolve({ ok: code === 0, stdout, stderr });
      });
    });
}

// ── 交互辅助 ──────────────────────────────────────────────────

/** 回答是否为「是」（y / yes；其余含 undefined = 否，fail-closed）。 */
function isYes(answer: string | undefined): boolean {
  const value = answer?.trim().toLowerCase();
  return value === 'y' || value === 'yes';
}

// ── 命令入口 ──────────────────────────────────────────────────

/**
 * 执行 `concertoai review`。
 *
 * @returns 退出码：0 = 无 A 级（严重）问题；1 = 有 A 级 / 判不了（非仓库、没装 git、缺 Key）。
 */
export async function runReviewCommand(options: ReviewCommandOptions = {}): Promise<number> {
  if (options.lang !== undefined) {
    setLocale(resolveLocale(options.lang));
  }
  const dict = t().review;
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.log(line));
  const logErr = options.logErr ?? ((line: string) => process.stderr.write(`${line}\n`));

  // ── ① severity 校验（非法值 fail-closed：不启动审查，别拿错阈值给结论）──
  const severity = parseReviewSeverity(options.severity);
  if (!severity.ok) {
    log(formatInvalidSeverity(severity.value));
    return 1;
  }

  // ── ② 审查范围（缺省 = git 改动的文件）──
  const scope = await resolveReviewScope({
    cwd,
    ...(options.path !== undefined ? { given: options.path } : {}),
    listGit: options.runGit ?? createGitNameLister(),
  });
  if (scope.kind === 'git-missing') {
    log(dict.gitMissing);
    log(dict.gitMissingHint);
    return 1;
  }
  if (scope.kind === 'not-repo') {
    log(dict.notRepo);
    log(dict.notRepoHint);
    return 1;
  }
  if (scope.kind === 'empty') {
    // 没有改动 = 没有 A 级问题（退出码 0），但必须说清「审的是零个文件」，不是「审完没问题」
    log(dict.noChanges);
    log(dict.noChangesHint);
    return 0;
  }
  // 两种来源（显式 path / git 改动）最终都收敛成同一个 scope 形状，
  // 与 TUI `/review <path>` 传给引擎的 `{ type: 'files', paths }` 完全一致
  const reviewScope: ReviewOptions['scope'] = { type: 'files', paths: scope.paths };
  if (scope.kind === 'given') {
    log(fmt(dict.scopeGiven, { path: scope.paths.join(', ') }));
  } else {
    log(fmt(dict.scopeChanged, { count: scope.paths.length }));
    if (scope.total > scope.paths.length) {
      log(
        fmt(dict.scopeTruncated, {
          count: scope.total - scope.paths.length,
          limit: MAX_REVIEW_FILES,
        }),
      );
    }
  }

  // ── ③ 引擎（缺 Key 又要现场造引擎 → 如实说清，不静默假审查）──
  const client =
    options.client ??
    (options.apiKey !== undefined ? new DeepSeekClient({ apiKey: options.apiKey }) : undefined);
  /**
   * 生效模型：**整个命令只解析这一处**，审查与 `--fix` 共用同一个值。
   *
   * K10（v5.0 T23.3 手工测试实测）：此前只在「现场造引擎」分支里解析当前模型，
   * 而 `--fix` 拿到的是**未解析的 model** —— 用户不敲 `-m` 时恒为 `undefined`，
   * `reviewer/autofix.ts` 据此判定「未配置模型，无法生成修复补丁」，于是
   * **有可修点也 100% 修不动，且原因说反**（同一进程刚刚用模型审完 9 个维度）。
   * 「同一个事实在两个地方各解析一次」是这类『说法与事实不符』的温床，故收敛成一个变量。
   */
  const model = options.model ?? resolveModel(undefined);
  let engine = options.engine;
  if (engine === undefined) {
    if (client === undefined) {
      log(dict.needsApiKey);
      log(dict.needsApiKeyHint);
      return 1;
    }
    engine = new ReviewerEngine(new SubagentSpawner(client, { cwd }, model), cwd);
  }
  const activeEngine = engine;

  logErr(
    fmt(dict.reviewing, {
      scope: scope.kind === 'given' ? scope.paths.join(', ') : String(scope.paths.length),
    }),
  );

  // ── ④ 审查（复用既有引擎；severity 透传，与 TUI /review 同一份语义）──
  let report = await activeEngine.review({
    scope: reviewScope,
    ...(severity.severity !== undefined ? { severity: severity.severity } : {}),
  });

  // ── ⑤ --fix：修「可自动修的问题」（autofix 的 A 批），每次写盘审批 ──
  if (options.fix === true) {
    report = await runFixPhase(report, {
      cwd,
      client,
      // K10：**必须是上面解析出的生效模型**，不能是原始的 `options.model`
      //（否则用户不敲 `-m` 时恒 undefined → 一条也修不动）
      model,
      engine: activeEngine,
      dict,
      log,
      logErr,
      isTTY: options.isTTY ?? process.stdin.isTTY === true,
      ...(options.requestApproval !== undefined
        ? { requestApproval: options.requestApproval }
        : {}),
      ...(options.runVerify !== undefined ? { runVerify: options.runVerify } : {}),
      ...(options.snapshots !== undefined ? { snapshots: options.snapshots } : {}),
      ...(options.ask !== undefined ? { ask: options.ask } : {}),
    });
  }

  // ── ⑥ 输出：先**原样**打 TUI 的共享报告，再追加 CLI 专属两块 ──
  for (const line of ReviewerEngine.formatReport(report).split('\n')) {
    log(line);
  }
  log('');
  for (const line of formatDimensionOverview(report)) {
    log(line);
  }
  log('');
  for (const line of formatReviewVerdict(report)) {
    log(line);
  }

  return reviewExitCode(report);
}

// ── --fix 阶段 ────────────────────────────────────────────────

/** `--fix` 阶段的依赖（从命令入口传入，避免再多一层全局状态）。 */
interface FixPhaseParams {
  cwd: string;
  client: ModelClient | undefined;
  /**
   * 生效模型 ID（**必填**：命令入口已解析出「用户没写 `-m` 时的默认模型」）。
   *
   * 这里刻意不给可选——K10 的病根就是「两处各拿一次，一处解析一处不解析」，
   * 类型上把它钉成必有，能让「忘了传」在编译期就红，而不是等用户跑出「未配置模型」。
   */
  model: string;
  engine: ReviewEngineLike;
  dict: ReturnType<typeof t>['review'];
  log: (line: string) => void;
  logErr: (line: string) => void;
  isTTY: boolean;
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  runVerify?: () => Promise<{ passed: boolean }>;
  snapshots?: SnapshotManager;
  ask?: (question: string) => Promise<string | undefined>;
}

/**
 * 执行 `--fix`：委托 `ReviewerEngine.autoFix`（内部 A/B 分批 → 批量审批 → 快照 →
 * 写盘 → 增量体检 → commit / 回滚），本函数只负责「审批怎么问」和「结果怎么说」。
 *
 * 交互次数 ≤ 2：① 用户显式敲 `--fix`；② A 批补丁一次性批量审批。不再多问。
 */
async function runFixPhase(report: ReviewReport, params: FixPhaseParams): Promise<ReviewReport> {
  const { dict } = params;
  // 没有可自动修的问题 → 直接说明，不进审批（省掉一次无意义的 y/N）
  const autoFixable = report.issues.filter(
    (issue) => issue.severity === 'suggestion' && issue.file !== '',
  );
  if (autoFixable.length === 0) {
    params.log(dict.fixNoAuto);
    return report;
  }
  // 非交互终端没法审批 → 一个字节都不写（fail-closed）
  if (!params.isTTY && params.requestApproval === undefined) {
    params.log(dict.fixNeedsTty);
    return report;
  }

  params.log(dict.fixScope);
  const ask = params.ask ?? ((question: string) => promptLine(question));
  const promptApproval = async (request: ApprovalRequest): Promise<boolean> => {
    if (!params.isTTY) {
      return false;
    }
    params.log('');
    params.log(fmt(dict.approvalTitle, { summary: request.summary }));
    if (request.detail !== undefined) {
      params.log(request.detail);
    }
    return isYes(await ask(dict.approvalPrompt));
  };
  const requestApproval = params.requestApproval ?? promptApproval;
  // 缺省体检：复用 T15 的 `runCheck`（同一份四段判定，不另造一套 verify 调用）
  const runVerify =
    params.runVerify ??
    (async (): Promise<{ passed: boolean }> => ({
      passed: (await runCheck({ cwd: params.cwd })).ok,
    }));
  const snapshots = params.snapshots ?? new SnapshotManager(params.cwd);

  const result = await params.engine.autoFix(report, {
    cwd: params.cwd,
    ...(params.client !== undefined ? { client: params.client } : {}),
    // `model` 必填（见 FixPhaseParams）→ 无条件透传，不再有「undefined 就不传」的分支
    model: params.model,
    requestApproval,
    runVerify,
    snapshots,
    onProgress: (fixed, total) => {
      params.logErr(fmt(dict.fixProgress, { fixed, total }));
    },
  });
  // 计数以 `report.fixResult` 为准（那是引擎写下的权威明细）；
  // 引擎只回了 `rolledBack: boolean`，拿不到明细时按「是否发生过回滚」退化计数。
  const counts = result.report.fixResult ?? {
    fixed: result.fixed,
    manual: result.manual,
    rolledBack: result.rolledBack ? 1 : 0,
  };
  params.log(
    fmt(dict.fixDone, {
      fixed: counts.fixed,
      manual: counts.manual,
      rolledBack: counts.rolledBack,
    }),
  );
  if (counts.rolledBack > 0) {
    params.log(dict.fixRollbackHint);
  }
  return result.report;
}
