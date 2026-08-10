/**
 * /self-heal 斜杠命令处理器（v3.1 M1 / T1.4）。
 *
 * 被 App.tsx 的 send 函数在调用 runLoop 前拦截处理。
 * 触发 `runSelfHeal` 主流程：执行 `npm run verify` → 失败自动走 M1 闭环
 * （分类 → 修复 → 验证 → 回滚，全程快照保护）。
 *
 * 修复期间 App 置 streaming 阶段（状态条可见），不阻塞主对话流。
 */

import { type RepairVerifyResult, runSelfHeal } from '../../loop/self-heal';
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
    log: (m) => logs.push(m),
  });
  return { message: formatSelfHealReport(result), result };
}

// ── 报告格式化 ──

/** 尝试动作中文名。 */
function actionLabel(action: string): string {
  switch (action) {
    case 'lint-fix':
      return 'lint 直修';
    case 'model-fix':
      return '模型修复';
    default:
      return '跳过';
  }
}

/** 尝试过程摘要（每轮一行）。 */
function formatAttempts(result: RepairVerifyResult): string {
  if (result.attempts.length === 0) {
    return '';
  }
  const lines = result.attempts.map((a, i) => {
    const action = actionLabel(a.action);
    const fixes =
      a.appliedFixes.length > 0 ? ` ${a.appliedFixes.map((f) => f.file).join(', ')}` : '';
    let outcome: string;
    if (a.rolledBack === true) {
      outcome = `→ ❌ 已回滚（${a.rollbackReason ?? '未知原因'}）`;
    } else if (a.action === 'none') {
      outcome =
        a.feedback.length > 0 ? `→ ⏭ 未修复（${a.feedback[0]?.suggestion ?? ''}）` : '→ ⏭ 跳过';
    } else if (a.report.passed) {
      outcome = '→ ✅ verify 通过';
    } else {
      outcome = '→ 🔁 继续（仍有错误）';
    }
    return `${i + 1}. 第 ${a.attempt} 次尝试：${action}${fixes} ${outcome}`;
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
  return `### 剩余错误（${errors.length} 个，转人工）\n${lines.join('\n')}`;
}

/** 将修复结果格式化为中文报告（CLI 与 chat 共用）。 */
export function formatSelfHealReport(result: RepairVerifyResult): string {
  if (result.passed && result.attempts.length === 0) {
    return '✅ verify 全部通过，无需修复';
  }
  const head = result.passed
    ? '✅ self-heal 修复完成：verify 全部通过'
    : result.exceeded
      ? '❌ 修复超限（已尝试全部次数），请人工处理'
      : '❌ verify 失败，请人工处理';
  const attemptBlock = formatAttempts(result);
  const remaining = formatRemainingErrors(result);
  const parts = [head];
  if (attemptBlock !== '') {
    parts.push(`### 修复过程\n${attemptBlock}`);
  }
  if (remaining !== '') {
    parts.push(remaining);
  }
  if (result.passed) {
    parts.push('快照已提交，无残留。');
  } else {
    parts.push(
      '⚠️ 已启用快照保护：修复无效的变更已回滚；残留快照可用 `concertoai snapshot list` 查看。',
    );
  }
  return parts.join('\n\n');
}
