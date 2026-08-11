/**
 * /self-heal 斜杠命令处理器（v3.1 M1 / T1.4）。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 * 触发 `runSelfHeal` 主流程：执行 `npm run verify` → 失败自动走 M1 闭环
 * （分类 → 修复 → 验证 → 回滚，全程快照保护）。
 *
 * 修复期间 App 置 streaming 阶段（状态条可见），不阻塞主对话流。
 */

import { fmt, t } from '../../i18n';
import { type RepairVerifyResult, runSelfHeal, type SelfHealPhase } from '../../loop/self-heal';
import type { ModelClient } from '../../model/client';
import type { ApprovalRequest, ToolContext } from '../../tools/registry';

// ── 命令解析 ──

/** 识别 `/self-heal`（无参数；带参数视为用法提示）。 */
export function parseSelfHealCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed === '/self-heal' || trimmed.startsWith('/self-heal ');
}

// ── 命令执行 ──

/** /self-heal 执行结果。 */
export interface SelfHealCommandResult {
  /** 显示给用户的消息。 */
  message: string;
  /** 完整修复报告（供审计/详情展示）。 */
  result: RepairVerifyResult;
}

/** /self-heal 执行选项（透传 runSelfHeal；测试可注入 runVerify/runLintFix）。 */
export interface SelfHealCommandOptions {
  client?: ModelClient;
  model?: string;
  requestApproval?: (r: ApprovalRequest) => Promise<boolean> | boolean;
  /** 测试注入：执行 verify（缺省跑真实 `npm run verify`）。 */
  runVerify?: () => Promise<{ stdout: string; stderr: string }>;
  /** 测试注入：执行 lint:fix（缺省走 shell 白名单 `npm run lint:fix`）。 */
  runLintFix?: () => Promise<{ ok: boolean }>;
  /** 阶段回调（v3.2 M4 / T4.2）：随 verify/lint-fix/model-fix/... 动态更新 UI。 */
  onPhase?: (phase: SelfHealPhase) => void;
}

/** 阶段标签（App.tsx 状态条展示；v3.2 M4 / T4.2；v3.3 S1 移入 i18n）。 */
export function selfHealPhaseLabel(phase: SelfHealPhase): string {
  const d = t().selfHeal;
  switch (phase) {
    case 'verify':
      return d.phaseVerify;
    case 'lint-fix':
      return d.phaseLintFix;
    case 'model-fix':
      return d.phaseModelFix;
    case 'verify-fix':
      return d.phaseVerifyFix;
    case 'rollback':
      return d.phaseRollback;
    case 'done':
      return d.phaseDone;
  }
}

/** 执行 /self-heal：运行 verify → 失败走 M1 闭环 → 返回中文报告。 */
export async function executeSelfHealCommand(
  ctx: ToolContext,
  options: SelfHealCommandOptions = {},
): Promise<SelfHealCommandResult> {
  const logs: string[] = [];
  const result = await runSelfHeal({
    cwd: ctx.cwd,
    client: options.client,
    model: options.model,
    requestApproval: options.requestApproval,
    runVerify: options.runVerify,
    runLintFix: options.runLintFix,
    onPhase: options.onPhase,
    log: (m) => logs.push(m),
  });
  return { message: formatSelfHealReport(result), result };
}

// ── 报告格式化 ──

/** 尝试动作标签（v3.3 S1：移入 i18n）。 */
function actionLabel(action: string): string {
  const d = t().selfHeal;
  switch (action) {
    case 'lint-fix':
      return d.actionLintFix;
    case 'model-fix':
      return d.actionModelFix;
    default:
      return d.actionSkip;
  }
}

/** 尝试过程摘要（每轮一行）。 */
function formatAttempts(result: RepairVerifyResult): string {
  if (result.attempts.length === 0) {
    return '';
  }
  const d = t().selfHeal;
  const lines = result.attempts.map((a, i) => {
    const action = actionLabel(a.action);
    const fixes =
      a.appliedFixes.length > 0 ? ` ${a.appliedFixes.map((f) => f.file).join(', ')}` : '';
    let outcome: string;
    if (a.rolledBack === true) {
      outcome = fmt(d.rolledBack, { reason: a.rollbackReason ?? d.unknownReason });
    } else if (a.action === 'none') {
      outcome =
        a.feedback.length > 0
          ? fmt(d.notFixed, { suggestion: a.feedback[0]?.suggestion ?? '' })
          : d.skipped;
    } else if (a.report.passed) {
      outcome = d.verifyPassed;
    } else {
      outcome = d.keepGoing;
    }
    return fmt(d.attemptLine, {
      n: i + 1,
      attempt: a.attempt,
      action,
      fixes,
      outcome,
    });
  });
  return lines.join('\n');
}

/** 剩余错误明细（各段 errors）。 */
function formatRemainingErrors(result: RepairVerifyResult): string {
  const errors = result.report.errors;
  if (errors.length === 0) {
    return '';
  }
  const lines = errors.map((e) => {
    const loc = e.file !== undefined ? `${e.file}:${e.line ?? '?'}` : '—';
    return `- [${e.stage}] ${loc} ${e.code ?? ''} ${e.message}`.trimEnd();
  });
  return `${fmt(t().selfHeal.remainingTitle, { count: errors.length })}\n${lines.join('\n')}`;
}

/** 将修复结果格式化为报告（CLI 与 chat 共用；v3.3 S1 文案走 i18n）。 */
export function formatSelfHealReport(result: RepairVerifyResult): string {
  const d = t().selfHeal;
  if (result.passed && result.attempts.length === 0) {
    return d.verifyPassedNoFix;
  }
  const head = result.passed ? d.repairedPassed : result.exceeded ? d.exceeded : d.verifyFailed;
  const attemptBlock = formatAttempts(result);
  const remaining = formatRemainingErrors(result);
  const parts = [head];
  if (attemptBlock !== '') {
    parts.push(`${d.repairProcessTitle}\n${attemptBlock}`);
  }
  if (remaining !== '') {
    parts.push(remaining);
  }
  if (result.passed) {
    parts.push(d.snapshotCommitted);
  } else {
    parts.push(d.snapshotProtection);
  }
  // T2.4：快照登记失败 → 明确告知快照保护未生效（修复可能无法回滚）
  if (result.snapshotWarning === true) {
    parts.push(d.snapshotWarning);
  }
  return parts.join('\n\n');
}
