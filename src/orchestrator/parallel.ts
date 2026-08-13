/**
 * 多 Agent 并行执行模块（v4.0 M5 / T5.1~T5.3，`team --parallel`）。
 *
 * 能力：
 * - detectParallelIntent：自然语言并行意图识别（「同时做 A 和 B」→ true）；
 * - buildParallelGroups：拆解任务按依赖分层（同层可并行，层间串行，复用
 *   topologicalSort）；纯串行链时 parallelizable=false（降级串行 + 提示）；
 * - runParallelTeams：每任务独立小闭环（coder→reviewer→qa）并行执行，
 *   上下文隔离（每任务独立 AgentContext/taskId），组内文件冲突检测
 *   （复用 scheduler.detectFileConflicts）+ 冲突串行化（安全写盘）。
 *
 * 安全：审批 fail-closed 由调用方（team.ts）保证；快照登记/回滚由调用方
 * 的 SnapshotManager + 事务感知 writer 保证（本模块不触碰磁盘）。
 */

import type { ArchitectSpec } from '../agents/architect';
import type { OrchestratorTask } from '../agents/orchestrator';
import {
  type AgentContext,
  type CoderLike,
  CyclicDependencyError,
  detectFileConflicts,
  type FileConflict,
  type LoopRoundRecord,
  type QaLike,
  type ReviewerLike,
  runTeamLoop,
  type SchedulerTask,
  type TeamLoopResult,
  topologicalSort,
} from './index';

// ── 类型定义 ──────────────────────────────────────────────────

/** 并行执行选项。 */
export interface ParallelRunOptions {
  /** 拆解出的任务清单（依赖已由模型声明）。 */
  tasks: OrchestratorTask[];
  /** 每个任务的 spec 工厂（缺省用任务描述构造最小 spec）。 */
  specFor?: (task: OrchestratorTask) => ArchitectSpec;
  /** Coder（共享实例；每任务 context.taskId 隔离）。 */
  coder: CoderLike;
  /** Reviewer（共享实例）。 */
  reviewer: ReviewerLike;
  /** QA（共享实例；并行 verify 由测试注入 fake）。 */
  qa: QaLike;
  /** 每任务每轮记录回调（可观测性/进度推送）。 */
  onTaskProgress?: (taskId: string, record: LoopRoundRecord) => void;
  /** 每任务闭环超限/失败回滚回调（快照回滚由调用方实现）。 */
  onRollback?: (taskId: string, reason: string) => Promise<void> | void;
  /** 组内文件冲突处理：'serialize'（冲突任务整组串行，默认）| 'abort'（报告冲突不执行）。 */
  conflictMode?: 'serialize' | 'abort';
}

/** 并行执行结果。 */
export interface ParallelRunResult {
  /** 是否全部成功（无失败 / 无跳过 / 未 abort）。 */
  ok: boolean;
  /** 分层（每层任务可并行；层间串行）。 */
  groups: OrchestratorTask[][];
  /** 任务 id → 闭环结果。 */
  results: Map<string, TeamLoopResult>;
  /** 检测到的文件冲突（组内；conflictMode='serialize' 时已整组串行化）。 */
  conflicts: FileConflict[];
  /** 是否实际发生并行（false = 纯串行链，逐层单任务执行）。 */
  parallelized: boolean;
  /** 中文汇总文案。 */
  summary: string;
}

// ── 并行意图识别（T5.1）──────────────────────────────────────

/** 并行意图强关键词（「一起」等弱信号不纳入，避免误触发）。 */
const PARALLEL_HINTS = ['同时', '并行', '分别', '各自', '并发', '多线程', '同时做'] as const;

/**
 * 自然语言并行意图识别：出现「同时/并行/分别/各自/并发/多线程」等强关键词 → true。
 * 调用方（team.ts）在用户未显式 --parallel 时用此判断是否进入并行分支；
 * 即使误报，buildParallelGroups 检测到纯串行链会降级串行并提示（不产生副作用）。
 */
export function detectParallelIntent(text: string): boolean {
  return PARALLEL_HINTS.some((hint) => text.includes(hint));
}

// ── 任务分层（T5.1：拆解 → 可并行组）─────────────────────────

/**
 * 按依赖关系分层：同层任务无依赖链（可并行），层间严格满足依赖约束。
 * 返回 [[]] 结构；所有层都只有 1 个任务时 parallelizable=false（调用方降级串行）。
 * 检测到循环依赖抛 CyclicDependencyError（与调度器一致）。
 */
export function buildParallelGroups(tasks: OrchestratorTask[]): OrchestratorTask[][] {
  if (tasks.length === 0) {
    return [];
  }
  const schedulerTasks: SchedulerTask[] = tasks.map((t) => ({
    id: t.id,
    dependencies: t.dependencies,
    files: t.files,
    run: async () => ({ ok: true }),
  }));
  const topo = topologicalSort(schedulerTasks);
  if (topo.cycle !== undefined && topo.cycle.length > 0) {
    throw new CyclicDependencyError(topo.cycle);
  }
  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  // wave = max(depWave) + 1（与 scheduler.computeLayers 同语义）
  const wave = new Map<string, number>();
  for (const id of topo.order) {
    const task = idToTask.get(id);
    let currentWave = 0;
    for (const dep of task?.dependencies ?? []) {
      currentWave = Math.max(currentWave, (wave.get(dep) ?? 0) + 1);
    }
    wave.set(id, currentWave);
  }
  const layers: OrchestratorTask[][] = [];
  for (const id of topo.order) {
    const currentWave = wave.get(id) ?? 0;
    const task = idToTask.get(id);
    if (task === undefined) {
      continue;
    }
    if (layers[currentWave] === undefined) {
      layers[currentWave] = [];
    }
    layers[currentWave]?.push(task);
  }
  return layers;
}

/** 判断分组是否存在可并行层（任意层任务数 > 1）。 */
export function isParallelizable(groups: OrchestratorTask[][]): boolean {
  return groups.some((g) => g.length > 1);
}

// ── 组内文件冲突（T5.2）──────────────────────────────────────

/**
 * 检测所有并行组内的文件冲突（同层任务修改同一文件且无依赖链）。
 * 复用 scheduler.detectFileConflicts（输入转 SchedulerTask 形状）。
 */
export function detectGroupConflicts(groups: OrchestratorTask[][]): FileConflict[] {
  const conflicts: FileConflict[] = [];
  for (const group of groups) {
    if (group.length < 2) {
      continue;
    }
    const schedulerTasks: SchedulerTask[] = group.map((t) => ({
      id: t.id,
      dependencies: t.dependencies,
      files: t.files,
      run: async () => ({ ok: true }),
    }));
    conflicts.push(...detectFileConflicts(schedulerTasks));
  }
  return conflicts;
}

// ── 并行执行（T5.2 / T5.3）────────────────────────────────────

/** 构造每个任务的独立上下文（隔离：taskId 唯一，sessionId 共享，artifacts 独立）。 */
function makeTaskContext(sessionId: string, task: OrchestratorTask): AgentContext {
  const context: AgentContext = {
    sessionId,
    taskId: task.id,
    dependencies: task.dependencies,
    artifacts: [],
  };
  return context;
}

/** 最小 ArchitectSpec（无 specFor 时的兜底）。 */
function minimalSpec(task: OrchestratorTask): ArchitectSpec {
  return {
    requirement: task.description,
    interfaces: [],
    files: (task.files ?? []).map((file) => ({ path: file, purpose: '任务涉及文件' })),
    constraints: ['按任务描述实现，保持现有代码风格'],
  };
}

/** 执行单个任务的对抗性闭环（独立 context；失败/超限触发 onRollback(taskId)）。 */
async function runSingleTeam(
  options: ParallelRunOptions,
  sessionId: string,
  task: OrchestratorTask,
): Promise<TeamLoopResult> {
  const context = makeTaskContext(sessionId, task);
  const spec = options.specFor?.(task) ?? minimalSpec(task);
  return runTeamLoop({
    coder: options.coder,
    reviewer: options.reviewer,
    qa: options.qa,
    spec,
    context,
    onAttempt: (record) => options.onTaskProgress?.(task.id, record),
    onRollback: (reason) => options.onRollback?.(task.id, reason),
  });
}

/** 汇总并行结果：成功/失败统计 + 冲突提示（T5.2 中文文案）。 */
export function buildParallelSummary(
  results: Map<string, TeamLoopResult>,
  conflicts: FileConflict[],
  parallelized: boolean,
): string {
  const failed: string[] = [];
  for (const [taskId, result] of results) {
    if (!result.ok) {
      failed.push(taskId);
    }
  }
  const lines: string[] = [];
  if (!parallelized) {
    lines.push('无法拆解为可并行任务，已按顺序执行');
  }
  const okCount = results.size - failed.length;
  lines.push(
    failed.length === 0
      ? `✅ ${okCount} 个任务全部完成`
      : `⚠️ 完成 ${okCount} 个 / 失败 ${failed.length} 个（${failed.join('、')}）`,
  );
  for (const conflict of conflicts) {
    lines.push(
      `⚠️ ${conflict.taskA} 和 ${conflict.taskB} 都修改了 ${conflict.file}，请检查保留哪个版本`,
    );
  }
  return lines.join(' ');
}

/**
 * 并行执行全部任务（按层；层内并行，层间串行）。
 *
 * 冲突处理（T5.2）：组内检测到文件冲突时，conflictMode='serialize'（默认）整组串行
 * 执行（避免并行写同一文件产生竞态），冲突清单随汇总报告展示；'abort' 时该组不执行，
 * 结果 ok=false。
 */
export async function runParallelTeams(options: ParallelRunOptions): Promise<ParallelRunResult> {
  const { tasks } = options;
  const groups = buildParallelGroups(tasks);
  const parallelized = isParallelizable(groups);
  const results = new Map<string, TeamLoopResult>();
  const conflicts = detectGroupConflicts(groups);
  const sessionId = `team-parallel-${Date.now()}`;

  for (const group of groups) {
    const groupHasConflict = conflicts.some((c) =>
      group.some((t) => t.id === c.taskA || t.id === c.taskB),
    );
    const conflictMode = options.conflictMode ?? 'serialize';
    if (groupHasConflict && conflictMode === 'abort') {
      // abort：报告冲突不执行（fail-closed）
      return {
        ok: false,
        groups,
        results,
        conflicts,
        parallelized,
        summary: `检测到文件冲突，已中止执行：${conflicts.map((c) => `${c.taskA}/${c.taskB} → ${c.file}`).join('; ')}`,
      };
    }
    // 冲突组整组串行（安全写盘）；无冲突组并行执行
    if (groupHasConflict) {
      for (const task of group) {
        const result = await runSingleTeam(options, sessionId, task);
        results.set(task.id, result);
      }
    } else {
      await Promise.all(
        group.map(async (task) => {
          const result = await runSingleTeam(options, sessionId, task);
          results.set(task.id, result);
        }),
      );
    }
  }

  const ok = [...results.values()].every((r) => r.ok) && results.size === tasks.length;
  return {
    ok,
    groups,
    results,
    conflicts,
    parallelized,
    summary: buildParallelSummary(results, conflicts, parallelized),
  };
}
