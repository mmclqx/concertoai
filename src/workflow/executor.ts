/**
 * 工作流执行引擎（v4.0 M2 T2.3）。
 *
 * 复用（禁止另起炉灶，§3.4）：
 * - TaskScheduler（DAG 拓扑排序 + 波次并行 + 重试 + 文件冲突 serialize）；
 * - SnapshotManager（整体快照事务回滚：任一步失败且用户放弃 → 全部回滚）。
 *
 * 失败恢复 UX（T2.3）：
 * - 失败后回调 onFailure({ failedStep, error }) → 用户选择 [R]重试 [S]跳过 [F]修复后重试 [A]放弃；
 * - retry / fix-and-retry：重跑失败步骤及其未完成下游（已完成步骤不重跑）；
 * - skip：失败步骤标记跳过，其下游剔除该依赖后继续执行；
 * - abort：停止执行 + 整体快照回滚（fail-closed，不留下半成品）。
 *
 * 审批节点（require: approval）：执行前调 requestApproval 暂停等待；拒绝视为失败
 * （fail-closed），进入失败恢复流程。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SchedulerTask } from '../orchestrator/scheduler';
import { TaskScheduler, topologicalSort } from '../orchestrator/scheduler';
import type { SnapshotManager } from '../orchestrator/transaction';
import type {
  Workflow,
  WorkflowProgress,
  WorkflowRunResult,
  WorkflowStep,
  WorkflowStepResult,
} from './types';

// ── 类型 ──────────────────────────────────────────────────────

/** 失败恢复选择。 */
export type RecoveryChoice = 'retry' | 'skip' | 'fix-and-retry' | 'abort';

/** 命令执行器（CLI 注入：spawn/exec；测试注入 fake）。 */
export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 输出是否被截断（v4.1 T1.1：超长输出截断，UI 据此标注「已截断」）。 */
  truncated?: boolean;
}>;

/** 失败恢复回调（由 CLI 层交互实现；缺省 abort，fail-closed）。 */
export interface FailureInfo {
  /** 失败步骤名。 */
  failedStep: string;
  /** 失败原因（命令 stderr / 审批拒绝）。 */
  error: string;
  /** 截至失败时的部分执行结果。 */
  result: WorkflowRunResult;
}

/** 执行选项。 */
export interface WorkflowRunOptions {
  /** 工作目录。 */
  cwd: string;
  /** 命令执行器。 */
  runCommand: CommandRunner;
  /** 审批回调（require: approval 步骤；缺省拒绝 = fail-closed）。 */
  requestApproval?: (step: WorkflowStep, index: number) => Promise<boolean> | boolean;
  /** 进度回调（长任务可感知，渐进推送）。 */
  onProgress?: (progress: WorkflowProgress) => void;
  /** 失败恢复选择器（缺省 abort）。 */
  onFailure?: (info: FailureInfo) => Promise<RecoveryChoice> | RecoveryChoice;
  /** 快照管理器（缺省不启用事务回滚保护）。 */
  snapshots?: SnapshotManager;
  /** 快照 taskId 前缀（默认 `workflow`）。 */
  snapshotPrefix?: string;
  /** 日志输出。 */
  log?: (message: string) => void;
}

/** 恢复轮次上限（防异常死循环；用户每次主动选择，正常不会触达）。 */
const MAX_RECOVERY_ROUNDS = 10;

/** 快照 taskId 前缀。 */
const DEFAULT_SNAPSHOT_PREFIX = 'workflow';

// ── 执行引擎 ──────────────────────────────────────────────────

/**
 * 执行工作流（DAG 依赖排序 + 并行 + 审批 + 失败恢复 + 整体回滚）。
 *
 * 步骤执行顺序由 TaskScheduler 按依赖拓扑排序；同层无依赖步骤并行执行。
 * 失败恢复循环：每轮调度「未完成步骤」（已完成不重跑），直到全部完成或用户放弃。
 */
export async function runWorkflow(
  workflow: Workflow,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  const log = options.log ?? (() => {});
  const total = workflow.steps.length;
  const doneSet = new Set<string>();
  const userSkippedSet = new Set<string>();
  const stepStates = new Map<string, WorkflowStepResult>();

  // 整体快照（声明 files 合并去重；执行前登记原状）
  const allFiles = [...new Set(workflow.steps.flatMap((s) => s.files ?? []))];
  const snapshots = options.snapshots;
  const taskId = `${options.snapshotPrefix ?? DEFAULT_SNAPSHOT_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let txStarted = false;
  if (snapshots !== undefined && allFiles.length > 0) {
    try {
      await snapshots.begin(taskId, allFiles);
      txStarted = true;
    } catch (err) {
      log(
        `[workflow] 快照登记失败，跳过回滚保护: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 记录步骤最终状态。 */
  const record = (name: string, state: WorkflowStepResult['state'], error?: string): void => {
    stepStates.set(name, { name, state, error });
  };

  /** 构建「未完成步骤」的调度任务（已完成/用户跳过步骤剔除；其依赖边对已剔除节点过滤）。 */
  const buildTasks = (): SchedulerTask[] => {
    const remaining = workflow.steps.filter(
      (s) => !doneSet.has(s.name) && !userSkippedSet.has(s.name),
    );
    return remaining.map((step) => ({
      id: step.name,
      dependencies: (step.depends ?? []).filter((d) => !doneSet.has(d) && !userSkippedSet.has(d)),
      files: step.files,
      run: async () => {
        // 审批节点：暂停等待用户确认（fail-closed：拒绝 → 失败）
        if (step.require === 'approval' && options.requestApproval !== undefined) {
          options.onProgress?.({
            done: doneSet.size,
            total,
            stepName: step.name,
            state: 'waiting-approval',
          });
          let approved = false;
          try {
            approved = await options.requestApproval(step, workflow.steps.indexOf(step));
          } catch {
            approved = false;
          }
          if (!approved) {
            return { ok: false, error: '用户拒绝审批' };
          }
        }
        options.onProgress?.({ done: doneSet.size, total, stepName: step.name, state: 'running' });
        const out = await options.runCommand(step.run, options.cwd);
        if (!out.ok) {
          return { ok: false, error: out.stderr.trim() || `命令执行失败: ${step.run}` };
        }
        // 登记该步骤声明文件的当前内容（供整体回滚时恢复；registerWrite 动态快照新文件）
        if (txStarted && snapshots !== undefined) {
          for (const file of step.files ?? []) {
            try {
              const content = await readFile(path.resolve(options.cwd, file), 'utf8');
              await snapshots.registerWrite(taskId, file, content);
            } catch {
              await snapshots.registerWrite(taskId, file, '').catch(() => {});
            }
          }
        }
        return { ok: true };
      },
    }));
  };

  // v4.1 T1.3：内部重试归零——工作流步骤失败直接交回外层 R/S/F/A 恢复 UI，
  // 禁止调度器静默自动重试（否则 lint 连跑 3 遍刷屏 + 外层恢复 UI 失去意义）。
  // 步骤级 retry 语义重定义为「恢复后重试上限」，在下方恢复循环中按步骤计数。
  const scheduler = new TaskScheduler({ fileConflict: 'serialize', maxRetries: 0 });
  let failedStep: string | undefined;
  let failedError: string | undefined;
  let aborted = false;
  /** 步骤恢复次数（retry 语义：用户在 R/S/F/A 恢复中重试该步骤的次数）。 */
  const recoveryCount = new Map<string, number>();

  // 失败恢复主循环
  for (let round = 0; round < MAX_RECOVERY_ROUNDS && !aborted; round += 1) {
    const remaining = workflow.steps.filter(
      (s) => !doneSet.has(s.name) && !userSkippedSet.has(s.name),
    );
    if (remaining.length === 0) {
      break;
    }
    const result = await scheduler.schedule(buildTasks());
    for (const id of result.completed.keys()) {
      doneSet.add(id);
      record(id, 'done');
    }
    options.onProgress?.({ done: doneSet.size, total, stepName: '', state: 'done' });

    const firstFailed = [...result.failed.entries()][0];
    if (firstFailed === undefined) {
      // 无失败：级联 skipped（不应出现，防御性处理）标记跳过
      for (const id of result.skipped) {
        userSkippedSet.add(id);
        record(id, 'skipped');
      }
      break;
    }
    failedStep = firstFailed[0];
    failedError = firstFailed[1];
    record(failedStep, 'failed', failedError);
    log(`[workflow] 步骤 ${failedStep} 失败: ${failedError}`);

    // 级联 skipped：保持未完成（下轮依赖剔除后重新调度）
    // 失败恢复选择
    const partial = toRunResult(workflow, doneSet, userSkippedSet, stepStates, failedStep, aborted);
    const choice =
      options.onFailure !== undefined
        ? await options.onFailure({ failedStep, error: failedError, result: partial })
        : 'abort';
    if (choice === 'abort') {
      aborted = true;
      break;
    }
    if (choice === 'retry' || choice === 'fix-and-retry') {
      // v4.1 T1.3：retry 语义 = 恢复后重试上限（缺省不限；N = 最多 N 次，超限强制 abort）
      const step = workflow.steps.find((s) => s.name === failedStep);
      const n = (recoveryCount.get(failedStep) ?? 0) + 1;
      recoveryCount.set(failedStep, n);
      const limit = step?.retry;
      if (limit !== undefined && n > limit) {
        log(`[workflow] 步骤 ${failedStep} 已达 retry 上限（${limit}），强制放弃（整体回滚）`);
        aborted = true;
        break;
      }
    }
    if (choice === 'skip') {
      userSkippedSet.add(failedStep);
      record(failedStep, 'skipped');
    }
  }

  // 事务收尾：全部完成（含用户显式跳过）→ commit；放弃（abort，部分未完成）→ 整体回滚
  const allDone = workflow.steps.every((s) => doneSet.has(s.name) || userSkippedSet.has(s.name));
  if (txStarted && snapshots !== undefined) {
    try {
      if (allDone) {
        await snapshots.commit(taskId);
      } else if (aborted) {
        const rb = await snapshots.rollback(taskId);
        if (!rb.ok) {
          log(
            `[workflow] 整体回滚部分失败: ${rb.failed.map((f) => `${f.path}: ${f.error}`).join('; ')}`,
          );
        }
      }
    } catch (err) {
      log(`[workflow] 快照收尾异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return toRunResult(workflow, doneSet, userSkippedSet, stepStates, failedStep, aborted);
}

/** 汇总执行结果（按整体拓扑序排列步骤结果）。 */
function toRunResult(
  workflow: Workflow,
  doneSet: Set<string>,
  skippedSet: Set<string>,
  stepStates: Map<string, WorkflowStepResult>,
  failedStep: string | undefined,
  aborted: boolean,
): WorkflowRunResult {
  const order = topologicalSort(
    workflow.steps.map((s) => ({
      id: s.name,
      dependencies: s.depends ?? [],
      run: () => ({ ok: true }),
    })),
  ).order;
  const steps = order.map((name) => {
    const known = stepStates.get(name);
    if (known !== undefined) {
      return known;
    }
    if (doneSet.has(name)) {
      return { name, state: 'done' as const };
    }
    if (skippedSet.has(name)) {
      return { name, state: 'skipped' as const };
    }
    const pendingState: WorkflowStepResult['state'] = aborted ? 'failed' : 'skipped';
    return { name, state: pendingState };
  });
  // 全部完成（含用户显式跳过）→ ok；仍有未完成（abort）→ failed
  const ok = workflow.steps.every((s) => doneSet.has(s.name) || skippedSet.has(s.name));
  return {
    ok,
    state: ok ? 'done' : 'failed',
    order,
    steps,
    failedStep,
    skipped: order.filter((name) => skippedSet.has(name)),
  };
}
