/**
 * `concertoai check` 命令（v5.0 M4 / T15）：提交前只读体检。
 *
 * ## 它回答一个问题
 *
 * 「现在这份代码，能不能提交？」——跑一遍既有检测（`npm run verify` 或分项
 * build / lint / typecheck / test），把输出切成四段给结论：
 * `✅ 可以提交` / `❌ N 项待修（lint / type）`，每段失败给「下一步命令」。
 *
 * ## 三条不可妥协的边界
 *
 * 1. **只读，零写入**：本模块**不调用** `lint:fix` / 不写盘 / 不建快照。
 *    体检就是体检，修东西是 `concertoai self-heal` 的事（用户 2026-10-28 拍板：
 *    `check` 先行，只读最安全）。
 * 2. **薄包装（G6）**：四段分类**复用** `src/loop/self-heal` 的 `parseVerifyReport`，
 *    失败摘要**复用** `src/utils/error-summary` 的 `extractErrorSummary`——
 *    本文件里没有第二套 verify 输出解析（护栏测试盯着这点）。
 * 3. **不静默成功**：没有 package.json / 没有任何检测脚本 / 退出码非 0 却解析不出原因，
 *    一律如实说「没检测 / 判不了」，绝不因为「没发现错误」就报「可以提交」。
 *
 * ## 退出码权威、解析只做归因
 *
 * 判定通过与否**看退出码**（子进程真实退出状态），解析结果只用来回答「哪一段挂了、
 * 挂在哪一行」。这样即便某个项目的输出形态没被解析器覆盖（例如 build 工具换了输出格式），
 * 也不会因为「解析不到错误」被误判成通过——反过来也不会因为「解析没认出成功标记」被误判成失败。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ChildProcessQaRunner, DEFAULT_VERIFY_TIMEOUT_MS, type QaRunResult } from '../agents/qa';
import { fmt, t } from '../i18n';
// G6 薄包装：四段分类复用既有分类器（禁止第二套解析）
import { parseVerifyReport, type VerifyError, type VerifyStage } from '../loop/self-heal';
// G6 薄包装：失败摘要复用既有提取器（禁止第二套错误摘要）
import { extractErrorSummary } from '../utils/error-summary';

// ── 常量 ──────────────────────────────────────────────────────

/** 四段的规范顺序（`npm run verify` 惯例：build → lint → typecheck → test）。 */
const CANONICAL_STAGES: readonly VerifyStage[] = ['build', 'lint', 'type', 'test'];

/** 段 → 可能的 npm 脚本名（按优先级；`type` 段兼容 `typecheck` 与 `type` 两种写法）。 */
const STAGE_SCRIPTS: Record<VerifyStage, readonly string[]> = {
  build: ['build'],
  lint: ['lint'],
  type: ['typecheck', 'type'],
  test: ['test'],
};

/** 每段输出最多展示/保留多少行（G5 边缘路径：超长输出必须截断，防淹没）。 */
export const MAX_STAGE_OUTPUT_LINES = 40;

/** 单条摘要的最大展示长度（错误信息可能极长）。 */
export const MAX_SUMMARY_DISPLAY = 200;

// ── 类型定义 ──────────────────────────────────────────────────

/** 体检方式：整条 verify / 分项脚本 / 无法体检。 */
export type CheckMode = 'verify' | 'per-stage' | 'none';

/** 单段状态（`unavailable` = 项目没配这个脚本，且不是「通过」）。 */
export type CheckStageStatus = 'pass' | 'fail' | 'skipped' | 'unknown' | 'unavailable';

/** 单段体检结果。 */
export interface CheckStageResult {
  /** 段名（build / lint / type / test）。 */
  stage: VerifyStage;
  /** 实际执行的 npm 脚本名（null = 项目未配置）。 */
  script: string | null;
  /** 段状态。 */
  status: CheckStageStatus;
  /** 解析到的错误条数（0 = 未解析到错误，不等於一定通过）。 */
  errorCount: number;
  /** 失败摘要（复用 error-summary 的可操作提示；通过时为空串）。 */
  summary: string;
  /** 该段的下一步命令（真实存在才给，null = 无建议）。 */
  nextCommand: string | null;
  /** 该段输出总行数（截断前）。 */
  outputLineCount: number;
  /** 输出是否被截断（输出行数 > MAX_STAGE_OUTPUT_LINES）。 */
  outputTruncated: boolean;
  /** 截断后的输出行（≤ MAX_STAGE_OUTPUT_LINES）。 */
  output: string[];
}

/** 体检结果（`--json` 直接序列化本结构，T17 的 commit 消费它）。 */
export interface CheckResult {
  /** 是否可以提交（全绿才 true）。 */
  ok: boolean;
  /** 体检方式。 */
  mode: CheckMode;
  /** 四段结果（按 build / lint / type / test 顺序）。 */
  stages: CheckStageResult[];
  /** 待修的段（按执行顺序）。 */
  failedStages: VerifyStage[];
  /** 一句结论。 */
  conclusion: string;
  /** 结论后的补充指引（无则空串）。 */
  conclusionHint: string;
  /** 下一步命令（去重、最多 3 条）。 */
  nextCommands: string[];
  /** 进程退出码（0 = 可以提交）。 */
  code: 0 | 1;
  /** 总耗时（毫秒）。 */
  durationMs: number;
}

/** check 命令选项（执行与依赖全部可注入，测试不跑真实 verify）。 */
export interface CheckCommandOptions {
  /** 工作目录（默认 process.cwd()）。 */
  cwd?: string;
  /** 输出结构化 JSON（不打印人类可读报告）。 */
  json?: boolean;
  /** 单条命令超时（默认 5min，与 verify 一致）。 */
  timeoutMs?: number;
  /** 输出函数（测试注入）。 */
  log?: (line: string) => void;
  /** 读取 package.json scripts（测试注入）。 */
  readScripts?: (cwd: string) => Promise<Record<string, string> | undefined>;
  /** 执行 `npm run <script>`（测试注入）。 */
  runScript?: (script: string) => Promise<QaRunResult>;
}

/** 一次脚本执行的结果（附加 error 用于承载「命令都没跑起来」的错误）。 */
interface RunOutcome extends QaRunResult {
  /** spawn 失败 / 命令不存在等（非退出码层面的错误）。 */
  error?: string;
}

// ── 注入默认实现 ──────────────────────────────────────────────

/**
 * 读取 package.json 的 scripts。
 *
 * 返回 `undefined` = 没有可读的 package.json（不是 Node 项目 / JSON 损坏）——
 * 调用方据此走「无法体检」分支，**不得**假装通过。
 */
export async function readPackageScripts(cwd: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = await readFile(path.join(cwd, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== 'object' || scripts === null) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof command === 'string') {
        out[name] = command;
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/** 安全执行：把「命令跑不起来」收敛成 outcome.error，不向上抛。 */
async function safeRun(
  run: (script: string) => Promise<QaRunResult>,
  script: string,
): Promise<RunOutcome> {
  try {
    return await run(script);
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── 纯函数：脚本 → 段映射、输出截断 ───────────────────────────

/**
 * 从 `verify` 脚本定义里读出段的执行顺序。
 *
 * 只解析**脚本定义**（`npm run build && npm run lint && …`），不触碰工具输出——
 * 这样「verify 先跑 test 再跑 build」的项目也能正确标出「哪段没执行」。
 * 未出现的段按规范顺序补在末尾。
 */
export function stageOrderFromVerifyScript(script: string): VerifyStage[] {
  const stageOf: Record<string, VerifyStage> = {
    build: 'build',
    lint: 'lint',
    typecheck: 'type',
    type: 'type',
    test: 'test',
  };
  const order: VerifyStage[] = [];
  for (const match of script.matchAll(/npm\s+run\s+([\w:.-]+)/g)) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    const stage = stageOf[name];
    if (stage !== undefined && !order.includes(stage)) {
      order.push(stage);
    }
  }
  for (const stage of CANONICAL_STAGES) {
    if (!order.includes(stage)) {
      order.push(stage);
    }
  }
  return order;
}

/** 项目里实际可跑的段（stage + 脚本名），按规范顺序。 */
export function pickStageScripts(
  scripts: Record<string, string>,
): Array<{ stage: VerifyStage; script: string }> {
  const picked: Array<{ stage: VerifyStage; script: string }> = [];
  for (const stage of CANONICAL_STAGES) {
    const script = STAGE_SCRIPTS[stage].find((name) => scripts[name] !== undefined);
    if (script !== undefined) {
      picked.push({ stage, script });
    }
  }
  return picked;
}

/** 截断输出（G5：超长输出不淹没终端）；返回截断行 + 原始行数。 */
export function truncateStageOutput(
  text: string,
  limit = MAX_STAGE_OUTPUT_LINES,
): { lines: string[]; total: number } {
  const all = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return { lines: all.slice(0, limit), total: all.length };
}

/** 把解析出的结构化错误格式化为一行（不做二次解析，只排版）。 */
function formatVerifyError(error: VerifyError): string {
  const location =
    error.file !== undefined
      ? `${error.file}${error.line !== undefined ? `:${error.line}` : ''}`
      : '';
  const code = error.code !== undefined ? ` [${error.code}]` : '';
  const text = `${location}${code} ${error.message}`.trim();
  return text.length <= MAX_SUMMARY_DISPLAY ? text : `${text.slice(0, MAX_SUMMARY_DISPLAY)}…`;
}

/**
 * 该段的下一步命令。
 *
 * ⚠️ 只给**真实存在**的命令（T10 / T12 的教训：文案里的命令是承诺，不能是空头支票）：
 * - `npm run lint:fix` 仅在项目真的配了这个脚本时才给；
 * - 其余一律指向已注册的 `concertoai self-heal`（M4 的 `fix` 尚未落地，不许写）。
 */
function nextCommandFor(stage: VerifyStage, scripts: Record<string, string>): string {
  if (stage === 'lint' && scripts['lint:fix'] !== undefined) {
    return 'npm run lint:fix';
  }
  return 'concertoai self-heal';
}

// ── 各段构造 ──────────────────────────────────────────────────

/** 构造「通过」段。 */
function passStage(stage: VerifyStage, script: string | null, text: string): CheckStageResult {
  const { lines, total } = truncateStageOutput(text);
  return {
    stage,
    script,
    status: 'pass',
    errorCount: 0,
    summary: '',
    nextCommand: null,
    outputLineCount: total,
    outputTruncated: total > MAX_STAGE_OUTPUT_LINES,
    output: lines,
  };
}

/** 构造「无法判定」/「跳过」/「未配置」等非通过段。 */
function pendingStage(
  stage: VerifyStage,
  script: string | null,
  status: 'skipped' | 'unknown' | 'unavailable',
  summary: string,
): CheckStageResult {
  return {
    stage,
    script,
    status,
    errorCount: 0,
    summary,
    nextCommand: null,
    outputLineCount: 0,
    outputTruncated: false,
    output: [],
  };
}

/** 段的下一步命令（供结果汇总）。 */
function stageNextCommand(stage: VerifyStage, scripts: Record<string, string>): string {
  return nextCommandFor(stage, scripts);
}

// ── 体检主逻辑 ────────────────────────────────────────────────

/** 执行体：verify（整条）与 per-stage（分项）共用同一份判定与文案。 */
export async function runCheck(options: CheckCommandOptions = {}): Promise<CheckResult> {
  const startedAt = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const dict = t().check;
  const readScripts = options.readScripts ?? readPackageScripts;
  const runScript =
    options.runScript ??
    ((script: string): Promise<QaRunResult> =>
      new ChildProcessQaRunner({ cwd, script }).run(timeoutMs));

  const scripts = await readScripts(cwd);

  // ① 不是 Node 项目（无 package.json）→ 如实说「无法体检」，绝不静默成功
  if (scripts === undefined) {
    return {
      ok: false,
      mode: 'none',
      stages: CANONICAL_STAGES.map((stage) => pendingStage(stage, null, 'unavailable', '')),
      failedStages: [],
      conclusion: dict.noPackageJson,
      conclusionHint: dict.noPackageJsonHint,
      nextCommands: [],
      code: 1,
      durationMs: Date.now() - startedAt,
    };
  }

  const picked = pickStageScripts(scripts);
  const verifyScript = scripts.verify;

  // ② 没有任何可用脚本 → 明确提示「没做检测」，不能报成功
  if (verifyScript === undefined && picked.length === 0) {
    return {
      ok: false,
      mode: 'none',
      stages: CANONICAL_STAGES.map((stage) =>
        pendingStage(stage, null, 'unavailable', dict.stageNoScript),
      ),
      failedStages: [],
      conclusion: dict.noScripts,
      conclusionHint: dict.noScriptsHint,
      nextCommands: [],
      code: 1,
      durationMs: Date.now() - startedAt,
    };
  }

  // ③ 有 verify 脚本 → 整条跑一次（与用户手敲 npm run verify 完全一致）
  if (verifyScript !== undefined) {
    const outcome = await safeRun(runScript, 'verify');
    const text = `${outcome.stdout}\n${outcome.stderr}`;
    const order = stageOrderFromVerifyScript(verifyScript);
    const scriptByStage = new Map(picked.map((item) => [item.stage, item.script]));

    // 命令都没跑起来（npm 不存在 / 权限）→ 全部判不了，如实报告
    if (outcome.error !== undefined) {
      return {
        ok: false,
        mode: 'verify',
        stages: order.map((stage) =>
          pendingStage(
            stage,
            scriptByStage.get(stage) ?? null,
            'unknown',
            fmt(dict.runFailed, { script: 'verify', error: truncateSummary(outcome.error ?? '') }),
          ),
        ),
        failedStages: [...order],
        conclusion: fmt(dict.runFailed, {
          script: 'verify',
          error: truncateSummary(outcome.error),
        }),
        conclusionHint: dict.conclusionHintSelfHeal,
        nextCommands: ['concertoai self-heal'],
        code: 1,
        durationMs: Date.now() - startedAt,
      };
    }

    // 超时 → 视为失败（不判通过）
    if (outcome.timedOut) {
      const summary = fmt(dict.timedOut, {
        script: 'verify',
        seconds: Math.round(timeoutMs / 1000),
      });
      return {
        ok: false,
        mode: 'verify',
        stages: order.map((stage) =>
          pendingStage(stage, scriptByStage.get(stage) ?? null, 'unknown', summary),
        ),
        failedStages: [...order],
        conclusion: summary,
        conclusionHint: dict.conclusionHintSelfHeal,
        nextCommands: ['concertoai self-heal'],
        code: 1,
        durationMs: Date.now() - startedAt,
      };
    }

    // 退出码权威：0 = 通过（解析只用于失败归因，避免「解析不到成功标记」被误判失败）
    if (outcome.ok) {
      return {
        ok: true,
        mode: 'verify',
        stages: order.map((stage) => passStage(stage, scriptByStage.get(stage) ?? null, text)),
        failedStages: [],
        conclusion: fmt(dict.allPass, {
          stages: order.join(' / '),
          seconds: secondsOf(startedAt),
        }),
        conclusionHint: '',
        nextCommands: [],
        code: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    // ④ 失败：复用既有分类器归因（哪段挂、挂几条），解析不出就用 error-summary 兜底
    const report = parseVerifyReport(outcome.stdout, outcome.stderr);
    const fallbackSummary = truncateSummary(extractErrorSummary(text).line);
    const errorStages = new Set(report.errors.map((error) => error.stage));
    const parseFailedStages = new Set(order.filter((stage) => report.parseFailed[stage]));
    const candidates = errorStages.size > 0 ? errorStages : parseFailedStages;
    const firstFailIndex = order.findIndex((stage) => candidates.has(stage));

    const stages: CheckStageResult[] = order.map((stage, index) => {
      const script = scriptByStage.get(stage) ?? null;
      if (firstFailIndex === -1) {
        // 退出码非 0 但一条错误都定位不出来 → 全部「无法判定」，请人工看原始输出
        const unknown = pendingStage(stage, script, 'unknown', dict.stageUnknown);
        const { lines, total } = truncateStageOutput(text);
        return {
          ...unknown,
          summary: `${dict.stageUnknown} ${fallbackSummary}`.trim(),
          nextCommand: stageNextCommand(stage, scripts),
          outputLineCount: total,
          outputTruncated: total > MAX_STAGE_OUTPUT_LINES,
          output: lines,
        };
      }
      if (index < firstFailIndex) {
        return passStage(stage, script, '');
      }
      const stageErrors = report.errors.filter((error) => error.stage === stage);
      if (index === firstFailIndex || stageErrors.length > 0) {
        const summary =
          stageErrors.length > 0
            ? formatVerifyError(stageErrors[0] as VerifyError)
            : fallbackSummary !== ''
              ? fallbackSummary
              : dict.stageUnknown;
        const { lines, total } = truncateStageOutput(text);
        return {
          stage,
          script,
          status: 'fail',
          errorCount: stageErrors.length,
          summary,
          nextCommand: stageNextCommand(stage, scripts),
          outputLineCount: total,
          outputTruncated: total > MAX_STAGE_OUTPUT_LINES,
          output: lines,
        };
      }
      // 失败段之后的段：`&&` 链没跑到 → 如实标「未执行」，不冒充通过
      return pendingStage(stage, script, 'skipped', dict.stageSkipped);
    });

    return finish(stages, scripts, order, 'verify', dict, startedAt);
  }

  // ⑤ 无 verify 脚本 → 分项检测（每段独立跑，退出码权威）
  const stages: CheckStageResult[] = [];
  for (const stage of CANONICAL_STAGES) {
    const item = picked.find((entry) => entry.stage === stage);
    if (item === undefined) {
      stages.push(pendingStage(stage, null, 'unavailable', dict.stageNoScript));
      continue;
    }
    const outcome = await safeRun(runScript, item.script);
    const text = `${outcome.stdout}\n${outcome.stderr}`;
    if (outcome.error !== undefined) {
      stages.push({
        ...pendingStage(
          stage,
          item.script,
          'unknown',
          fmt(dict.runFailed, { script: item.script, error: truncateSummary(outcome.error ?? '') }),
        ),
        nextCommand: stageNextCommand(stage, scripts),
      });
      continue;
    }
    if (outcome.timedOut) {
      stages.push({
        ...pendingStage(
          stage,
          item.script,
          'unknown',
          fmt(dict.timedOut, {
            script: item.script,
            seconds: Math.round(timeoutMs / 1000),
          }),
        ),
        nextCommand: stageNextCommand(stage, scripts),
      });
      continue;
    }
    if (outcome.ok) {
      stages.push(passStage(stage, item.script, text));
      continue;
    }
    // 失败：先试复用分类器归因（同一份解析），再退到 error-summary
    const report = parseVerifyReport(outcome.stdout, outcome.stderr);
    const stageErrors = report.errors.filter((error) => error.stage === stage);
    const errors = stageErrors.length > 0 ? stageErrors : report.errors;
    const summaryFromErrors = errors.length > 0 ? formatVerifyError(errors[0] as VerifyError) : '';
    const summary =
      summaryFromErrors !== ''
        ? summaryFromErrors
        : truncateSummary(extractErrorSummary(text).line) || dict.stageUnknown;
    const { lines, total } = truncateStageOutput(text);
    stages.push({
      stage,
      script: item.script,
      status: 'fail',
      errorCount: errors.length,
      summary,
      nextCommand: stageNextCommand(stage, scripts),
      outputLineCount: total,
      outputTruncated: total > MAX_STAGE_OUTPUT_LINES,
      output: lines,
    });
  }

  return finish(
    stages,
    scripts,
    CANONICAL_STAGES.filter((stage) => picked.some((entry) => entry.stage === stage)),
    'per-stage',
    dict,
    startedAt,
  );
}

/** 汇总：结论 + 待修段 + 下一步命令 + 退出码。 */
function finish(
  stages: CheckStageResult[],
  scripts: Record<string, string>,
  order: readonly VerifyStage[],
  mode: CheckMode,
  dict: ReturnType<typeof t>['check'],
  startedAt: number,
): CheckResult {
  const failed = stages.filter((stage) => stage.status === 'fail' || stage.status === 'unknown');
  const ok = failed.length === 0;
  const failedStages = order.filter((stage) => failed.some((item) => item.stage === stage));

  const nextCommands: string[] = [];
  for (const stage of failedStages) {
    const command = nextCommandFor(stage, scripts);
    // 段专属命令（如 lint → npm run lint:fix）先给：它最便宜、最确定
    if (command !== 'concertoai self-heal' && !nextCommands.includes(command)) {
      nextCommands.push(command);
    }
  }
  if (failedStages.length > 0) {
    // 兜底与闭环入口永远在（它是唯一能把「待修」变成「可提交」且真实存在的命令）
    nextCommands.push('concertoai self-heal');
  }

  return {
    ok,
    mode,
    stages,
    failedStages,
    conclusion: ok
      ? fmt(dict.allPass, { stages: order.join(' / '), seconds: secondsOf(startedAt) })
      : fmt(dict.failed, { count: failedStages.length, stages: failedStages.join(' / ') }),
    conclusionHint: ok ? '' : dict.conclusionHintSelfHeal,
    nextCommands: nextCommands.slice(0, 3),
    code: ok ? 0 : 1,
    durationMs: Date.now() - startedAt,
  };
}

/** 秒数（一位小数），用于耗时展示。 */
function secondsOf(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

/** 摘要单行化 + 截断（空串原样返回）。 */
function truncateSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_SUMMARY_DISPLAY
    ? oneLine
    : `${oneLine.slice(0, MAX_SUMMARY_DISPLAY)}…`;
}

// ── 渲染 ──────────────────────────────────────────────────────

/** 段状态图标（纯展示，不含文案）。 */
const STATUS_ICON: Record<CheckStageStatus, string> = {
  pass: '✅',
  fail: '❌',
  skipped: '⏭️',
  unknown: '⚠️',
  unavailable: '⏸️',
};

/** 单段一行的描述文案。 */
function stageDetail(stage: CheckStageResult, dict: ReturnType<typeof t>['check']): string {
  switch (stage.status) {
    case 'pass':
      return dict.stagePass;
    case 'fail':
      return stage.errorCount > 0
        ? fmt(dict.stageFail, { count: stage.errorCount, summary: stage.summary })
        : fmt(dict.stageFailNoCount, { summary: stage.summary });
    case 'skipped':
      return dict.stageSkipped;
    case 'unavailable':
      return dict.stageNoScript;
    default:
      return stage.summary !== '' ? stage.summary : dict.stageUnknown;
  }
}

/**
 * 把体检结果渲染成人类可读的行（纯字符串，便于测试与后续 TUI 复用）。
 *
 * 结构：标题 → 四段各一行 → 空行 → 一句结论 → 下一步命令。
 * 输出行数受控（每段最多一行 + 命令最多 3 条），超长输出不会淹没终端。
 */
export function formatCheckReport(result: CheckResult): string[] {
  const dict = t().check;
  const lines: string[] = [];
  if (result.mode === 'per-stage') {
    const names = result.stages
      .filter((stage) => stage.script !== null)
      .map((stage) => stage.script as string);
    lines.push(fmt(dict.modePerStage, { scripts: names.join(' / ') }));
  } else if (result.mode === 'verify') {
    lines.push(dict.modeVerify);
  } else {
    lines.push(dict.title);
  }

  const width = Math.max(...result.stages.map((stage) => stage.stage.length));
  for (const stage of result.stages) {
    lines.push(
      `${STATUS_ICON[stage.status]} ${stage.stage.padEnd(width)}  ${stageDetail(stage, dict)}`,
    );
    if (stage.outputTruncated) {
      lines.push(
        `   ${fmt(dict.outputTruncated, {
          total: stage.outputLineCount,
          limit: MAX_STAGE_OUTPUT_LINES,
        })}`,
      );
    }
  }

  lines.push('');
  lines.push(result.conclusion);
  if (result.conclusionHint !== '') {
    lines.push(result.conclusionHint);
  }
  if (result.nextCommands.length > 0) {
    lines.push(dict.nextTitle);
    result.nextCommands.forEach((command, index) => {
      const why =
        command === 'concertoai self-heal'
          ? dict.whySelfHeal
          : command === 'npm run lint:fix'
            ? dict.whyLintFix
            : dict.whySelfHeal;
      lines.push(`   ${fmt(dict.nextItem, { index: index + 1, command, why })}`);
    });
  }
  return lines;
}

/** 命令入口：打印报告（或 `--json`）并返回退出码。 */
export async function runCheckCommand(options: CheckCommandOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const result = await runCheck(options);
  /**
   * v5.0 T21：记一条体检指标（只记「几段过 / 几段挂」，不记错误内容）。
   *
   * - **默认 off**（`config.metrics` 缺省 `off`）→ 连文件都不会碰；
   * - `void` 出去，不 await：体检的报告优先级永远高于指标；
   * - 只有 `concertoai check` 这一条命令记（`commit` 内部复用 `runCheck` 不记，
   *   否则一次提交会同时留下 verb + check 两条，指标口径会重复）。
   */
  void (async () => {
    try {
      const { recordCheckMetric } = await import('./metrics');
      await recordCheckMetric({
        ok: result.ok,
        passed: result.stages.filter((stage) => stage.status === 'pass').length,
        failed: result.failedStages.length,
      });
    } catch {
      // 指标失败静默（不影响体检结论与退出码）
    }
  })();
  if (options.json === true) {
    log(JSON.stringify(result, null, 2));
    return result.code;
  }
  for (const line of formatCheckReport(result)) {
    log(line);
  }
  return result.code;
}
