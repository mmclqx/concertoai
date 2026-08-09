/**
 * 任务状态机（v3.0 M2 / T2.1，任务生命周期）。
 *
 * 实现任务生命周期状态机：pending → in_progress → awaiting_review → awaiting_qa
 * → completed / failed，含状态转换守卫与事件订阅。
 *
 * 转换图（对抗性闭环 T3.5 消费）：
 * - pending → in_progress：任务开始执行（守卫：依赖必须全部 completed）；
 * - in_progress → awaiting_review：Coder 实现完成，交 Reviewer 审查；
 * - awaiting_review → awaiting_qa：Reviewer approve，进入 QA；
 * - awaiting_review → in_progress：Reviewer reject，打回 Coder 修复；
 * - awaiting_qa → completed：QA 全绿，任务完成；
 * - awaiting_qa → in_progress：QA 失败，打回 Coder 修复；
 * - 任意非终止态 → failed：执行失败 / 异常终止。
 *
 * 非法转换（不在图中）抛 InvalidTransitionError；守卫拒绝抛 TransitionGuardError，
 * 两者均记录到 violations（供可观测性 T5.1 展示）。状态变更事件可订阅
 * （onTransition，返回取消函数）。completed / failed 为终止态，不可再转换。
 */

import type { TaskStatus } from './types';

// ── 状态转换图 ────────────────────────────────────────────────

/** 状态转换表（静态导出：文档 / 测试 / 可观测性展示共用）。 */
export const TRANSITIONS: readonly { from: TaskStatus; to: TaskStatus }[] = [
  { from: 'pending', to: 'in_progress' },
  { from: 'pending', to: 'failed' },
  { from: 'in_progress', to: 'awaiting_review' },
  { from: 'in_progress', to: 'failed' },
  { from: 'awaiting_review', to: 'awaiting_qa' },
  { from: 'awaiting_review', to: 'in_progress' },
  { from: 'awaiting_review', to: 'failed' },
  { from: 'awaiting_qa', to: 'completed' },
  { from: 'awaiting_qa', to: 'in_progress' },
  { from: 'awaiting_qa', to: 'failed' },
];

/** 模块级邻接表（构建自 TRANSITIONS，O(1) 查询）。 */
const TRANSITION_MAP = new Map<TaskStatus, Set<TaskStatus>>();
for (const { from, to } of TRANSITIONS) {
  let set = TRANSITION_MAP.get(from);
  if (!set) {
    set = new Set();
    TRANSITION_MAP.set(from, set);
  }
  set.add(to);
}

/** 终止态：不可再转换（completed / failed）。 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed']);

/** 判断是否为终止状态（completed / failed，不可再转换）。 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ── 错误类型 ──────────────────────────────────────────────────

/**
 * 非法状态转换错误：目标转换不在状态转换图中
 * （如 awaiting_qa → pending 拒绝，验收标准 #3）。
 */
export class InvalidTransitionError extends Error {
  /** 任务 ID。 */
  readonly taskId: string;
  /** 原状态。 */
  readonly from: TaskStatus;
  /** 目标状态。 */
  readonly to: TaskStatus;

  constructor(taskId: string, from: TaskStatus, to: TaskStatus, reason: string) {
    super(reason);
    this.name = 'InvalidTransitionError';
    this.taskId = taskId;
    this.from = from;
    this.to = to;
  }
}

/**
 * 状态转换守卫拒绝错误：转换在图中，但守卫条件未满足
 * （如 pending → in_progress 时依赖尚未全部 completed）。
 */
export class TransitionGuardError extends Error {
  /** 任务 ID。 */
  readonly taskId: string;
  /** 原状态。 */
  readonly from: TaskStatus;
  /** 目标状态。 */
  readonly to: TaskStatus;

  constructor(taskId: string, from: TaskStatus, to: TaskStatus, reason: string) {
    super(reason);
    this.name = 'TransitionGuardError';
    this.taskId = taskId;
    this.from = from;
    this.to = to;
  }
}

// ── 状态变更事件 ──────────────────────────────────────────────

/** 一次成功的状态变更（供 T5.1 可观测性消费）。 */
export interface TaskStateChange {
  /** 任务 ID。 */
  taskId: string;
  /** 原状态。 */
  from: TaskStatus;
  /** 新状态。 */
  to: TaskStatus;
  /** 变更原因（如 'reviewer approve' / 'qa failed'，可选）。 */
  reason?: string;
  /** 变更时间戳（epoch 毫秒）。 */
  timestamp: number;
}

/** 状态变更监听器（订阅可观测性 / 审计日志）。 */
export type TransitionListener = (change: TaskStateChange) => void;

// ── 非法转换记录（violations）────────────────────────────────

/** 非法转换 / 守卫拒绝的记录（供审计与可观测性展示）。 */
export interface InvalidTransitionRecord {
  /** 任务 ID。 */
  taskId: string;
  /** 原状态。 */
  from: TaskStatus;
  /** 目标状态。 */
  to: TaskStatus;
  /** 拒绝原因（非法转换或守卫拒绝）。 */
  reason: string;
  /** 记录时间戳（epoch 毫秒）。 */
  timestamp: number;
}

/** violations 记录默认上限（防止无限增长）。 */
export const DEFAULT_MAX_VIOLATIONS = 100;

// ── 状态机消费的任务记录 ──────────────────────────────────────

/**
 * 状态机操作的最小任务记录。
 * T2.2 调度器的完整 Task 可赋值兼容（多余字段不受影响）。
 */
export interface TaskStateRecord {
  /** 任务 ID。 */
  id: string;
  /** 依赖任务 ID 列表（pending → in_progress 守卫检查全部 completed）。 */
  dependencies: string[];
  /** 当前状态。 */
  status: TaskStatus;
  /** 当前负责的 Agent 名称（未分配时为空字符串）。 */
  agent?: string;
}

/** 转换检查结果（canTransitionTask 返回，含拒绝原因）。 */
export interface TransitionCheck {
  /** 是否允许转换。 */
  allowed: boolean;
  /** 拒绝原因（allowed 为 false 时给出，便于展示）。 */
  reason?: string;
}

// ── 状态机 ────────────────────────────────────────────────────

/** 状态机构造选项。 */
export interface TaskStateMachineOptions {
  /**
   * 依赖状态查询（供 pending → in_progress 守卫检查依赖是否全部 completed）。
   * 返回 undefined 表示依赖任务不存在或状态未知（守卫拒绝）。
   */
  getTaskStatus?: (taskId: string) => TaskStatus | undefined;
  /** violations 记录上限（默认 DEFAULT_MAX_VIOLATIONS）。 */
  maxViolations?: number;
}

/** 转换执行选项。 */
export interface TransitionOptions {
  /** 变更原因（记录到 TaskStateChange，供可观测性）。 */
  reason?: string;
  /** 转换后负责该任务的 Agent 名（可选，如 pending → in_progress 时分配）。 */
  agent?: string;
}

/**
 * 任务状态机：转换图查询 + 守卫校验 + 状态变更执行 + 事件订阅。
 * 单实例可服务全部任务（按 taskId 区分），violations 全局累计。
 */
export class TaskStateMachine {
  private readonly getTaskStatus?: (taskId: string) => TaskStatus | undefined;
  private readonly maxViolations: number;
  private readonly listeners = new Set<TransitionListener>();
  private readonly violationList: InvalidTransitionRecord[] = [];

  constructor(options?: TaskStateMachineOptions) {
    this.getTaskStatus = options?.getTaskStatus;
    this.maxViolations = options?.maxViolations ?? DEFAULT_MAX_VIOLATIONS;
  }

  /** 纯图查询：from → to 是否在状态转换图中（不执行守卫）。 */
  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return TRANSITION_MAP.get(from)?.has(to) ?? false;
  }

  /** 图 + 守卫联合检查（含拒绝原因，供调用方预检/展示）。 */
  canTransitionTask(task: TaskStateRecord, to: TaskStatus): TransitionCheck {
    if (!this.canTransition(task.status, to)) {
      return {
        allowed: false,
        reason: `非法状态转换: ${task.status} → ${to}（不在状态转换图中）`,
      };
    }
    const guardReason = this.checkGuard(task, to);
    if (guardReason) {
      return { allowed: false, reason: guardReason };
    }
    return { allowed: true };
  }

  /**
   * 执行状态转换：校验图与守卫 → 更新任务状态（和负责 Agent）→ 发事件 → 返回变更。
   * 非法转换抛 InvalidTransitionError；守卫拒绝抛 TransitionGuardError；均记录 violations。
   */
  transition(task: TaskStateRecord, to: TaskStatus, options?: TransitionOptions): TaskStateChange {
    const from = task.status;
    if (!this.canTransition(from, to)) {
      const reason = `非法状态转换: ${from} → ${to}（不在状态转换图中）`;
      this.recordViolation(task.id, from, to, reason);
      throw new InvalidTransitionError(task.id, from, to, reason);
    }
    const guardReason = this.checkGuard(task, to);
    if (guardReason) {
      this.recordViolation(task.id, from, to, guardReason);
      throw new TransitionGuardError(task.id, from, to, guardReason);
    }
    task.status = to;
    if (options?.agent !== undefined) {
      task.agent = options.agent;
    }
    const change: TaskStateChange = {
      taskId: task.id,
      from,
      to,
      reason: options?.reason,
      timestamp: Date.now(),
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // 可观测性 / 审计订阅方异常不应阻断状态机主流程
      }
    }
    return change;
  }

  /** 订阅状态变更事件，返回取消订阅函数。 */
  onTransition(listener: TransitionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 非法转换 / 守卫拒绝的记录（供审计与可观测性展示）。 */
  violations(): readonly InvalidTransitionRecord[] {
    return this.violationList;
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 守卫校验：返回拒绝原因（undefined 表示放行）。 */
  private checkGuard(task: TaskStateRecord, to: TaskStatus): string | undefined {
    if (task.status === 'pending' && to === 'in_progress') {
      return this.guardPendingToInProgress(task);
    }
    return undefined;
  }

  /** pending → in_progress 守卫：依赖必须全部 completed（fail-closed）。 */
  private guardPendingToInProgress(task: TaskStateRecord): string | undefined {
    if (task.dependencies.length === 0) {
      return undefined;
    }
    if (!this.getTaskStatus) {
      return `无法验证依赖状态：任务 ${task.id} 存在依赖但未配置 getTaskStatus（fail-closed 拒绝）`;
    }
    for (const dep of task.dependencies) {
      const depStatus = this.getTaskStatus(dep);
      if (depStatus === undefined) {
        return `依赖任务不存在或状态未知: ${dep}`;
      }
      if (depStatus !== 'completed') {
        return `依赖任务未完成: ${dep}（当前 ${depStatus}）`;
      }
    }
    return undefined;
  }

  /** 记录违规转换（带上限截断，防止无限增长）。 */
  private recordViolation(taskId: string, from: TaskStatus, to: TaskStatus, reason: string): void {
    this.violationList.push({ taskId, from, to, reason, timestamp: Date.now() });
    if (this.violationList.length > this.maxViolations) {
      this.violationList.shift();
    }
  }
}
