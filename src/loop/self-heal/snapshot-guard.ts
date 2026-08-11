/**
 * self-heal 快照守卫（v3.2 M2 / T2.2 + T2.4，原 self-heal.ts 模型修复内嵌 ~100 行）。
 *
 * applyModelFix：封装「生成计划 → 审批 → 快照登记 → 写盘 → verify → 判定 → 回滚/提交」
 * 完整状态机，repairVerifyReport 只调用并收集结果。
 *
 * 快照保护（T1.3）：
 * - 落盘前 `SnapshotManager.begin + recordWrite` 登记快照；
 * - 修复后 verify 判定：目标错误未消失（修复无效）或引入新错误 → rollback 恢复原状；
 * - 修复有效 → commit 清理快照；回滚失败（外部修改）→ 报错保留快照；
 * - 快照登记失败 → 放弃回滚保护继续写盘，置 snapshotWarning（T2.4，报告/CLI 展示）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseVerifyReport, type VerifyError, type VerifyReport } from './classifier';
import { diffLineStat, generateModelFixPlan, suggestionFor } from './model';
import type { ApplyModelFixResult, RepairVerifyOptions, SelfHealAttempt } from './types';

/** 错误指纹：`file:code`（忽略行号——修复后行号会漂移，仅凭 file+code 判定错误是否新增/消失）。 */
function errorFingerprint(error: VerifyError): string {
  return `${error.file ?? '<unknown>'}:${error.code ?? error.message}`;
}

/** 执行 verify 并解析（生产/测试共用；测试注入 runVerify）。 */
async function runVerifyAndParse(options: RepairVerifyOptions): Promise<VerifyReport> {
  const { stdout, stderr } = await options.runVerify();
  return parseVerifyReport(stdout, stderr);
}

/**
 * 单次模型修复完整状态机（T2.2 抽取）。
 *
 * 步骤：生成修复计划（失败→none）→ 审批（fail-closed，拒绝→none）→ 快照登记 → 写盘 →
 * verify → diff 审查 → 回滚/提交判定。
 *
 * @param error 目标 type 简单错误
 * @param report 修复前 verify 报告（回滚判定基准）
 * @param options 修复选项
 * @param attempt 本次尝试序号（1-based）
 * @returns attempt（本次尝试记录）+ snapshotWarning（快照登记是否失败）
 */
export async function applyModelFix(
  error: VerifyError,
  report: VerifyReport,
  options: RepairVerifyOptions,
  attempt: number,
): Promise<ApplyModelFixResult> {
  const log = options.log ?? (() => {});
  const plan = await generateModelFixPlan(error, options);
  if (plan === undefined) {
    log('[self-heal] 模型无法生成修复计划，跳过该错误');
    return {
      attempt: {
        attempt,
        action: 'none',
        report,
        appliedFixes: [],
        feedback: [{ code: error.code, suggestion: suggestionFor(error) }],
      },
      snapshotWarning: false,
    };
  }
  const approved =
    (await options.requestApproval?.({
      kind: 'edit',
      summary: `self-heal 修复类型错误: ${error.code ?? 'TS'} @ ${plan.file}:${error.line ?? '?'}`,
      detail: plan.diff,
    })) ?? false;
  if (!approved) {
    log('[self-heal] 用户拒绝模型修复，跳过该错误');
    return {
      attempt: {
        attempt,
        action: 'none',
        report,
        appliedFixes: [],
        feedback: [{ code: error.code, suggestion: '用户拒绝了自动修复，请手动处理' }],
      },
      snapshotWarning: false,
    };
  }

  // 审批通过 → 落盘（T1.3：落盘前登记快照，修复失败/引入新错误自动回滚）
  const absolute = path.resolve(options.cwd, plan.file);
  // taskId 加随机后缀：连续两轮修复可能落在同一毫秒，避免快照目录冲突
  const taskId = `${options.snapshotPrefix ?? 'self-heal'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const snapshots = options.snapshots;
  let txStarted = false;
  let snapshotWarning = false;
  if (snapshots !== undefined) {
    try {
      await snapshots.begin(taskId, [plan.file]);
      await snapshots.recordWrite(taskId, plan.file, plan.newContent);
      txStarted = true;
    } catch (err) {
      // 快照登记失败 → 放弃回滚保护继续写盘（与 T1.2 行为一致）；置 snapshotWarning（T2.4）
      await snapshots.commit(taskId).catch(() => {});
      log(
        `[self-heal] 快照登记失败，跳过回滚保护: ${err instanceof Error ? err.message : String(err)}`,
      );
      snapshotWarning = true;
    }
  }
  // 修复前错误指纹（回滚判定基准：目标错误是否消失 / 是否引入新错误）
  const beforeFingerprints = new Set(report.errors.map(errorFingerprint));
  try {
    await fs.writeFile(absolute, plan.newContent, 'utf8');
  } catch (err) {
    log(`[self-heal] 写盘失败: ${err instanceof Error ? err.message : String(err)}`);
    if (txStarted && snapshots !== undefined) {
      const rb = await snapshots.rollback(taskId);
      log(
        `[self-heal] 写盘失败，快照${rb.ok ? '已回滚清理' : `回滚失败（${rb.failed.map((f) => f.error).join('; ')}，快照保留）`}`,
      );
      return {
        attempt: {
          attempt,
          action: 'none',
          report,
          appliedFixes: [],
          feedback: [{ code: error.code, suggestion: '修复写盘失败，已回滚，请手动处理' }],
          rolledBack: true,
          rollbackReason: `写盘失败${rb.ok ? '' : `（回滚失败: ${rb.failed.map((f) => f.error).join('; ')}）`}`,
        },
        snapshotWarning,
      };
    }
    return {
      attempt: {
        attempt,
        action: 'none',
        report,
        appliedFixes: [],
        feedback: [{ code: error.code, suggestion: '修复写盘失败，请手动处理' }],
      },
      snapshotWarning,
    };
  }
  const fresh = await runVerifyAndParse(options);
  // diff 审查：变更文件 + 每文件变更行数（可读摘要）
  const stat = diffLineStat(plan.search, plan.replace);
  log(`[self-heal] diff 审查: ${plan.file}（+${stat.added} -${stat.removed}）`);
  // 回滚判定：目标类型错误未消失（修复无效）或引入了新错误 → rollback 恢复原状
  const targetGone = !fresh.errors.some((e) => errorFingerprint(e) === errorFingerprint(error));
  const newErrors = fresh.errors.filter((e) => !beforeFingerprints.has(errorFingerprint(e)));
  const regressed = !targetGone || newErrors.length > 0;
  let rolledBack = false;
  let rollbackReason: string | undefined;
  if (regressed) {
    const reason = !targetGone
      ? `目标类型错误 ${error.code ?? 'TS'} 未修复`
      : `引入新错误: ${newErrors
          .map((e) => e.code ?? e.message)
          .slice(0, 3)
          .join(', ')}`;
    if (txStarted && snapshots !== undefined) {
      const rb = await snapshots.rollback(taskId);
      rolledBack = rb.ok;
      rollbackReason = rb.ok
        ? reason
        : `${reason}；回滚失败（${rb.failed.map((f) => f.error).join('; ')}），快照保留待人工检查`;
      log(`[self-heal] 修复${rb.ok ? '已回滚' : '回滚失败，快照保留'}: ${reason}`);
    } else {
      rollbackReason = `${reason}（未启用快照，未回滚）`;
      log(`[self-heal] 修复疑似无效: ${reason}（无快照，请人工检查 ${plan.file}）`);
    }
  } else {
    if (txStarted && snapshots !== undefined) {
      await snapshots.commit(taskId);
    }
    log(`[self-heal] 修复有效，已${txStarted ? '提交快照' : '保留变更'}`);
  }
  const attemptResult: SelfHealAttempt = {
    attempt,
    action: 'model-fix',
    report: fresh,
    appliedFixes: [{ file: plan.file, diff: plan.diff }],
    feedback: [],
    // 回滚成功 → rolledBack=true；回滚失败/未启用快照 → 仅保留 rollbackReason（含失败详情）
    ...(rolledBack ? { rolledBack: true } : {}),
    ...(rollbackReason !== undefined ? { rollbackReason } : {}),
  };
  // 回滚成功 → 磁盘已恢复原状，report 维持修复前（下一轮重新处理）；否则磁盘为修复后状态
  return {
    attempt: rolledBack ? { ...attemptResult, report } : attemptResult,
    snapshotWarning,
  };
}
