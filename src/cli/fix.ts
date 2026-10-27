/**
 * `concertoai fix` 命令（v5.0 M4 / T16）：报错自动修——`self-heal` 的薄入口。
 *
 * ## 它回答一个问题
 *
 * 「verify 挂了，你能自己修吗？」——按既有 self-heal 闭环跑一遍：
 * 分类 → 修复（lint 直修 / 模型修复）→ 复验 → 无效则回滚，最多 `MAX_SELF_HEAL_ATTEMPTS`(2)
 * 次尝试，超限转人工并保留现场。
 *
 * ## 四条不可妥协的边界
 *
 * 1. **薄包装（G6）**：分类复用 `parseVerifyReport`、动作优先级复用 `strategyFor`
 *    （与真修同一份判定）、报告复用 `formatSelfHealReport`、执行复用 `runSelfHeal`。
 *    本文件里**没有第二套 verify 解析 / 第二套修复逻辑**。
 * 2. **`--dry-run` 零写入**：只跑 verify + 解析，输出「每条错误打算怎么修」的策略清单。
 *    不调模型（不花钱）、不调 `lint:fix`、不建快照、不写盘，**也不需要 API Key**——
 *    第一次进项目、还没配 Key 的用户也能先看清诊断（边缘路径①）。
 * 3. **每次修复走审批（两道门）**：
 *    - 门①：开跑前确认——覆盖 `lint:fix` 这类确定性修复（它本身不弹审批框）；
 *    - 门②：模型修复每次写盘前逐条确认（复用 `runSelfHeal` 的 `requestApproval`，
 *      fail-closed：非 TTY / Ctrl+C / 回答不是 y 一律当拒绝）。
 * 4. **判定看退出码（承接 T15 教训）**：`--dry-run` 的通过与否看子进程**真实退出码**，
 *    解析只用来回答「哪条错误、打算怎么修」。解析不出具体错误时如实说「没能定位」，
 *    绝不因为「解析不到错误」就报告「无需修复」（假通过）。
 *
 * ## 超限转人工时「明确的回滚命令」
 *
 * 只能给**真实存在**的命令（T10 / T12 空头支票教训，ADR-044）：
 * `concertoai snapshot list` 看残留快照、`concertoai snapshot clean` 清理，并打印快照目录。
 * 单快照恢复目前**没有** CLI（`snapshot restore` 不存在），所以文案里一个字都不许提它；
 * 修复无效的变更由 self-heal 在复验失败时**自动回滚**，不需要用户手敲回滚。
 */

import { ChildProcessQaRunner, DEFAULT_VERIFY_TIMEOUT_MS } from '../agents/qa';
import { fmt, resolveLocale, setLocale, t } from '../i18n';
import {
  MAX_SELF_HEAL_ATTEMPTS,
  parseVerifyReport,
  runSelfHeal,
  type SelfHealAction,
  strategyFor,
  suggestionFor,
  type VerifyError,
  type VerifyReport,
  type VerifyStage,
} from '../loop/self-heal';
import { DeepSeekClient, type ModelClient } from '../model/client';
import { SNAPSHOT_ROOT } from '../orchestrator/transaction';
import type { ApprovalRequest } from '../tools/registry';
import { resolveModel } from './common';
import { promptLine } from './prompt';
import { formatSelfHealReport } from './slash/self-heal';

// ── 常量 ──────────────────────────────────────────────────────

/** 诊断清单最多展示多少条错误（G5 边缘路径④：超长输出不淹没终端）。 */
export const MAX_DIAGNOSIS_ENTRIES = 20;

/** 单条错误信息最多展示多少字符。 */
export const MAX_MESSAGE_DISPLAY = 200;

// ── 类型定义 ──────────────────────────────────────────────────

/** verify 执行结果（含退出码：判定权威来源）。 */
export interface VerifyOutcome {
  /** 子进程退出码为 0。 */
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 诊断清单里的一条：一条错误 + 打算怎么修。 */
export interface FixPlanEntry {
  /** 所属段。 */
  stage: VerifyStage;
  /** 打算采取的动作（来自 strategyFor，与真修同源）。 */
  action: SelfHealAction;
  /** 位置 `file:line`（无法定位时为空串）。 */
  location: string;
  /** 错误码（可缺省）。 */
  code?: string;
  /** 错误信息（已截断单行化）。 */
  message: string;
  /** 未自动修时的可操作建议（来自 suggestionFor）。 */
  suggestion: string;
}

/** 诊断结论（`--dry-run` 的全部产出，纯数据便于断言）。 */
export interface FixDiagnosis {
  /** verify 是否通过（退出码权威）。 */
  passed: boolean;
  /** 诊断条目（最多 MAX_DIAGNOSIS_ENTRIES 条）。 */
  entries: FixPlanEntry[];
  /** 因超长被隐藏的条数（0 = 全部展示）。 */
  hiddenCount: number;
  /** 各动作的条数统计（按全部错误统计，不受截断影响）。 */
  counts: { lintFix: number; modelFix: number; manual: number };
  /** 尝试次数上限（复用 self-heal 常量，不另写一份数字）。 */
  attempts: number;
}

/** fix 命令选项（执行与交互全部可注入，测试不跑真实 verify / 不碰真实终端）。 */
export interface FixCommandOptions {
  /** 工作目录（沙箱根）。 */
  cwd: string;
  /** DeepSeek API Key（`--dry-run` 可省略：诊断不调模型）。 */
  apiKey?: string;
  /** 模型 ID（缺省用默认模型）。 */
  model?: string;
  /** 只诊断 + 出修复策略，不写盘。 */
  dryRun?: boolean;
  /** 自动批准全部修复（谨慎；默认两道门都问）。 */
  autoApprove?: boolean;
  /** 界面语言。 */
  lang?: string;
  /** 单条命令超时（默认与 verify 一致）。 */
  timeoutMs?: number;
  /** 模型客户端（测试注入；缺省按 apiKey 构造）。 */
  client?: ModelClient;
  /** 测试注入：执行 verify（缺省 spawn `npm run verify`，退出码参与判定）。 */
  runVerify?: () => Promise<VerifyOutcome>;
  /** 测试注入：执行 `npm run lint:fix`（透传给 self-heal）。 */
  runLintFix?: () => Promise<{ ok: boolean }>;
  /** 测试注入：模型修复写盘前的审批回调（缺省弹 y/N）。 */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  /** 测试注入：读一行回答（缺省走 `promptLine`）。 */
  ask?: (question: string) => Promise<string | undefined>;
  /** 测试注入：是否交互式终端（缺省 `process.stdin.isTTY`）。 */
  isTTY?: boolean;
  /** 报告输出（stdout）。 */
  log?: (line: string) => void;
  /** 过程日志（stderr）。 */
  logErr?: (line: string) => void;
}

// ── 纯函数：诊断 ──────────────────────────────────────────────

/** 单行化 + 截断（空串原样返回）。 */
function oneLine(text: string, limit = MAX_MESSAGE_DISPLAY): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 错误位置（`file:line`；都没有时为空串）。 */
function locationOf(error: VerifyError): string {
  if (error.file === undefined) {
    return '';
  }
  return error.line !== undefined ? `${error.file}:${error.line}` : error.file;
}

/**
 * 由 verify 报告构造诊断结论（纯函数）。
 *
 * 动作一律来自 `strategyFor`——与 `repairVerifyReport` 真修时的判定同源，
 * 保证「诊断说的」和「真修做的」不可能分叉（G6）。
 *
 * `passed` 取**退出码**结论（调用方传入），不取 `report.passed`：
 * 解析器认不出的输出形态不该被当成「没问题」（T15 假通过教训）。
 */
export function buildFixDiagnosis(params: { passed: boolean; report: VerifyReport }): FixDiagnosis {
  const { passed, report } = params;
  const entries: FixPlanEntry[] = report.errors.map((error) => {
    const action = strategyFor(error);
    return {
      stage: error.stage,
      action,
      location: locationOf(error),
      ...(error.code !== undefined ? { code: error.code } : {}),
      message: oneLine(error.message),
      suggestion: action === 'none' ? suggestionFor(error) : '',
    };
  });
  const counts = {
    lintFix: entries.filter((entry) => entry.action === 'lint-fix').length,
    modelFix: entries.filter((entry) => entry.action === 'model-fix').length,
    manual: entries.filter((entry) => entry.action === 'none').length,
  };
  return {
    passed,
    entries: entries.slice(0, MAX_DIAGNOSIS_ENTRIES),
    hiddenCount: Math.max(0, entries.length - MAX_DIAGNOSIS_ENTRIES),
    counts,
    attempts: MAX_SELF_HEAL_ATTEMPTS,
  };
}

/** 动作文案（走 i18n，en 下不混中文）。 */
function actionLabel(action: SelfHealAction): string {
  const d = t().fix;
  switch (action) {
    case 'lint-fix':
      return d.actionLintFix;
    case 'model-fix':
      return d.actionModelFix;
    default:
      return d.actionManual;
  }
}

/**
 * 把诊断结论渲染成人类可读的行（纯字符串，便于测试与 TUI 复用）。
 *
 * 结构：标题 → 结论 / 摘要 → 策略清单（每错误一行）→ 截断提示 → 空行 → `--dry-run` 声明。
 */
export function formatFixPlan(diagnosis: FixDiagnosis): string[] {
  const d = t().fix;
  const lines: string[] = [d.title];
  if (diagnosis.passed) {
    lines.push(d.passed);
    return lines;
  }
  if (diagnosis.entries.length === 0) {
    // 退出码非 0 却一条错误都定位不出来：如实说「判不了」，不冒充「无需修复」
    lines.push(d.unattributed);
  } else {
    lines.push(
      fmt(d.summaryLine, {
        count: diagnosis.counts.lintFix + diagnosis.counts.modelFix + diagnosis.counts.manual,
        lint: diagnosis.counts.lintFix,
        model: diagnosis.counts.modelFix,
        manual: diagnosis.counts.manual,
      }),
    );
    lines.push('');
    lines.push(fmt(d.planTitle, { attempts: diagnosis.attempts }));
    diagnosis.entries.forEach((entry, index) => {
      const where = entry.location !== '' ? entry.location : '—';
      const code = entry.code !== undefined ? ` [${entry.code}]` : '';
      const why = entry.suggestion !== '' ? `（${entry.suggestion}）` : '';
      lines.push(
        fmt(d.planLine, {
          index: index + 1,
          stage: entry.stage,
          location: where,
          code,
          action: actionLabel(entry.action),
          why,
          message: entry.message,
        }),
      );
    });
    if (diagnosis.hiddenCount > 0) {
      lines.push(fmt(d.moreErrors, { count: diagnosis.hiddenCount }));
    }
  }
  lines.push('');
  lines.push(d.dryRunNotice);
  lines.push(d.dryRunNext);
  return lines;
}

// ── 交互辅助 ──────────────────────────────────────────────────

/** 回答是否为「是」（y / yes；其余含 undefined = 否，fail-closed）。 */
function isYes(answer: string | undefined): boolean {
  const value = answer?.trim().toLowerCase();
  return value === 'y' || value === 'yes';
}

// ── 命令入口 ──────────────────────────────────────────────────

/**
 * 执行 `concertoai fix`。
 *
 * @returns 退出码：0 = verify 通过（无需修复或已修好）；1 = 仍有待修 / 已取消 / 失败。
 */
export async function runFixCommand(options: FixCommandOptions): Promise<number> {
  if (options.lang !== undefined) {
    setLocale(resolveLocale(options.lang));
  }
  const dict = t().fix;
  const log = options.log ?? ((line: string) => console.log(line));
  const logErr = options.logErr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const runVerify =
    options.runVerify ??
    (async (): Promise<VerifyOutcome> => {
      const runner = new ChildProcessQaRunner({ cwd: options.cwd });
      const outcome = await runner.run(options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS);
      // 退出码是判定权威（T15）：解析只做归因
      return { ok: outcome.ok, stdout: outcome.stdout, stderr: outcome.stderr };
    });

  // ── ① `--dry-run`：只诊断，零写入 ──
  if (options.dryRun === true) {
    logErr(dict.dryRunRunning);
    let outcome: VerifyOutcome;
    try {
      outcome = await runVerify();
    } catch (err) {
      log(
        fmt(dict.verifyRunFailed, {
          error: oneLine(err instanceof Error ? err.message : String(err)),
        }),
      );
      return 1;
    }
    const report = parseVerifyReport(outcome.stdout, outcome.stderr);
    const diagnosis = buildFixDiagnosis({ passed: outcome.ok, report });
    for (const line of formatFixPlan(diagnosis)) {
      log(line);
    }
    return diagnosis.passed ? 0 : 1;
  }

  // ── ② 真修：门①（开跑前确认，覆盖 lint:fix 这类免审批的确定性修复）──
  const isTTY = options.isTTY ?? process.stdin.isTTY === true;
  const ask = options.ask ?? ((question: string) => promptLine(question));
  if (options.autoApprove !== true) {
    if (!isTTY) {
      // fail-closed：非交互环境无法审批 → 不启动任何修复，并给出可用的两条路
      log(dict.needsTty);
      return 1;
    }
    const answer = await ask(fmt(dict.confirmStart, { attempts: MAX_SELF_HEAL_ATTEMPTS }));
    if (!isYes(answer)) {
      // 含 Ctrl+C（promptLine 返回 undefined）：体面退出，一个字节都没写
      log(dict.cancelled);
      return 1;
    }
  }

  // ── ③ 门②：模型修复每次写盘前逐条审批（fail-closed）──
  const promptApproval = async (request: ApprovalRequest): Promise<boolean> => {
    if (!isTTY) {
      return false;
    }
    log('');
    log(fmt(dict.approvalTitle, { summary: request.summary }));
    if (request.detail !== undefined) {
      log(request.detail);
    }
    return isYes(await ask(dict.approvalPrompt));
  };
  const requestApproval =
    options.autoApprove === true
      ? async (): Promise<boolean> => true
      : (options.requestApproval ?? promptApproval);

  const client =
    options.client ??
    (options.apiKey !== undefined ? new DeepSeekClient({ apiKey: options.apiKey }) : undefined);
  if (client === undefined) {
    // 没有 Key 也能修 lint；模型修复自动跳过（如实告知，不静默降级）
    log(dict.noApiKey);
  }
  const model = client === undefined ? undefined : (options.model ?? resolveModel(undefined));

  const result = await runSelfHeal({
    cwd: options.cwd,
    client,
    model,
    requestApproval,
    // 复用同一份 verify 执行器：退出码不参与 self-heal 判定（它按解析结果闭环），
    // 但注入点统一后测试只需准备一条时间线
    runVerify: async (): Promise<{ stdout: string; stderr: string }> => {
      const outcome = await runVerify();
      return { stdout: outcome.stdout, stderr: outcome.stderr };
    },
    ...(options.runLintFix !== undefined ? { runLintFix: options.runLintFix } : {}),
    log: logErr,
  });

  for (const line of formatSelfHealReport(result).split('\n')) {
    log(line);
  }
  if (result.passed) {
    return 0;
  }
  // ── ④ 未修好：转人工 + 现场保留（只用真实存在的命令）──
  log('');
  log(fmt(dict.failedHint, { attempts: MAX_SELF_HEAL_ATTEMPTS }));
  log(fmt(dict.sceneKept, { path: `${options.cwd}/${SNAPSHOT_ROOT}` }));
  return 1;
}
