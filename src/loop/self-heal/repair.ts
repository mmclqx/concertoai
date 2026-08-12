/**
 * self-heal 修复策略执行器（v3.2 M2 / T2.1 拆分，原 self-heal.ts T1.2）。
 *
 * 职责：
 * - 按错误分类执行确定性修复——lint → `npm run lint:fix`（白名单免审批）；
 *   type 简单错误 → applyModelFix（snapshot-guard 状态机，审批 fail-closed + 快照回滚）；
 *   build/test/type 复杂错误 → 结构化反馈不自动修；
 * - 尝试次数上限 `MAX_SELF_HEAL_ATTEMPTS = 2`，超限保留详细报告转人工；
 * - T2.3 增量 verify：lint 修复后仅 rerun lint 段（runLintOnly），通过则合并跳过全量；
 * - T2.4 快照保护失效警告：聚合 applyModelFix 的 snapshotWarning 到 RepairVerifyResult。
 */

import { fmt, t } from '../../i18n';
import type { VerifyReport } from './classifier';
import { mergeLintPassed, parseLintErrors, parseVerifyReport } from './classifier';
import { isSimpleTypeError, suggestionFor } from './model';
import { applyModelFix } from './snapshot-guard';
import type { RepairVerifyOptions, RepairVerifyResult, SelfHealAttempt } from './types';

/** 自我修复最大尝试次数（超限转人工）。 */
export const MAX_SELF_HEAL_ATTEMPTS = 2;

/** 每次模型修复仅修 1 个错误（避免连锁引入新错误）。 */
export const MAX_MODEL_FIXES_PER_ATTEMPT = 1;

/** 解析 verify 输出（生产：跑真实 npm run verify → parseVerifyReport）。 */
export async function runVerifyAndParse(options: RepairVerifyOptions): Promise<VerifyReport> {
  const { stdout, stderr } = await options.runVerify();
  return parseVerifyReport(stdout, stderr);
}

/**
 * 增量 verify（T2.3）：lint 修复后仅 rerun lint 段，通过则合并结果跳过全量。
 *
 * - 有 `runLintOnly` 注入：rerun lint 段 → lint 段通过（无错误且可解析）→
 *   `mergeLintPassed` 合并（移除 lint 错误，其他段沿用修复前状态），跳过全量 verify；
 * - lint 段仍失败 / 无 runLintOnly / 无法解析 → 回退全量 verify（lint 修复可能引入
 *   其他段错误或未修好，全量最稳妥）。
 */
export async function verifyAfterLintFix(
  options: RepairVerifyOptions,
  current: VerifyReport,
): Promise<VerifyReport> {
  if (options.runLintOnly !== undefined) {
    const lintOut = await options.runLintOnly();
    const lintResult = parseLintErrors(`${lintOut.stdout}\n${lintOut.stderr}`);
    if (!lintResult.parseFailed && lintResult.errors.length === 0) {
      return mergeLintPassed(current);
    }
  }
  return runVerifyAndParse(options);
}

/**
 * 修复策略执行器主流程。
 *
 * 每轮：
 * 1. lint 错误 → 确定性执行 lint:fix（免审批）→ 增量 verify（T2.3）；
 * 2. 首个 type 简单错误 → applyModelFix（快照守卫状态机：模型生成 → 审批 → 快照 → 写盘 →
 *    verify → 回滚/提交；T2.2 抽取）；
 * 3. 剩余（type 复杂 / build / test）→ 结构化反馈，不自动修。
 *
 * 尝试次数上限 MAX_SELF_HEAL_ATTEMPTS = 2，超限保留详细报告转人工。
 * 每次模型修复仅修 1 个错误。
 */
export async function repairVerifyReport(
  initial: VerifyReport,
  options: RepairVerifyOptions,
): Promise<RepairVerifyResult> {
  const log = options.log ?? (() => {});
  const onPhase = options.onPhase ?? (() => {});
  const attempts: SelfHealAttempt[] = [];
  let report = initial;
  let snapshotWarning = false;

  for (let attempt = 1; attempt <= MAX_SELF_HEAL_ATTEMPTS; attempt += 1) {
    if (report.passed) {
      break;
    }

    // 1) lint 错误 → 确定性 lint:fix
    const lintErrors = report.errors.filter((e) => e.stage === 'lint');
    if (lintErrors.length > 0) {
      log(
        fmt(t().selfHeal.logLintFixAttempt, {
          attempt,
          count: lintErrors.length,
        }),
      );
      // T4.2：lint 修复阶段
      onPhase('lint-fix');
      const fix = await options.runLintFix();
      // T4.2：修复后验证阶段
      onPhase('verify-fix');
      const fresh = await verifyAfterLintFix(options, report);
      attempts.push({
        attempt,
        action: 'lint-fix',
        report: fresh,
        appliedFixes: [],
        feedback: [],
      });
      report = fresh;
      if (!fix.ok) {
        // W1（v3.3）：lint:fix 执行失败（非零退出码）说明环境有问题（如 Biome 未安装），
        // 后续 type 简单错误即使可修也一并跳过（继续修复意义有限），显式转人工。
        // 注意：report 已更新为 lint 修复后的 verify 结果（fresh），供人工查看剩余错误。
        log(t().selfHeal.logLintFixFailed);
        break;
      }
      continue;
    }

    // 2) 首个 type 简单错误 → 模型修复（快照守卫状态机，每次 1 个）
    const simpleType = report.errors.find((e) => isSimpleTypeError(e));
    if (simpleType !== undefined) {
      log(
        fmt(t().selfHeal.logModelFixAttempt, {
          attempt,
          code: simpleType.code ?? 'TS',
          file: simpleType.file ?? '?',
          line: simpleType.line ?? '?',
        }),
      );
      // T4.2：模型修复阶段
      onPhase('model-fix');
      const r = await applyModelFix(simpleType, report, options, attempt);
      snapshotWarning = snapshotWarning || r.snapshotWarning;
      attempts.push(r.attempt);
      // 回滚成功 → 磁盘已恢复原状，report 维持修复前（下一轮重新处理）；否则磁盘为修复后状态
      report = r.attempt.rolledBack === true ? report : r.attempt.report;
      // T4.2：模型修复被回滚 → 回滚阶段
      if (r.attempt.rolledBack === true) {
        onPhase('rollback');
      }
      // action=none（模型无法生成计划 / 审批拒绝 fail-closed / 写盘失败）→ 停止
      // 本轮（与原版 break 语义一致：不继续尝试其他 type 错误，保留报告转人工）
      if (r.attempt.action === 'none') {
        break;
      }
      continue;
    }

    // 3) 剩余（type 复杂 / build / test）→ 结构化反馈，不自动修
    const feedback = report.errors.map((e) => ({
      code: e.code,
      suggestion: suggestionFor(e),
    }));
    attempts.push({ attempt, action: 'none', report, appliedFixes: [], feedback });
    log(t().selfHeal.logRemainingManual);
    break;
  }

  // T4.2：修复流程结束
  onPhase('done');
  const exceeded = !report.passed && attempts.length >= MAX_SELF_HEAL_ATTEMPTS;
  return {
    passed: report.passed,
    report,
    attempts,
    exceeded,
    // T2.4：任一次模型修复快照登记失败 → 置 warning（报告/CLI 展示）
    ...(snapshotWarning ? { snapshotWarning: true } : {}),
  };
}
