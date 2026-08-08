/**
 * 计划执行进度跟踪器。
 *
 * 状态机：pending → in_progress → completed | failed | skipped。
 * 每个步骤状态变更时通过回调通知 TUI，支持失败后用户选择跳过/重试。
 */

import type { DepsAnalysis, PlanStep } from './types';

/** 单步骤执行状态。 */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/** 单步骤运行时状态。 */
export interface StepState {
  step: PlanStep;
  status: StepStatus;
  /** 失败时的错误信息。 */
  error?: string;
  /** 步骤开始时间戳（ms）。 */
  startedAt?: number;
  /** 步骤完成时间戳（ms）。 */
  finishedAt?: number;
}

/** 进度变更事件。 */
export interface ProgressEvent {
  /** 当前步骤编号。 */
  stepIndex: number;
  /** 旧状态。 */
  from: StepStatus;
  /** 新状态。 */
  to: StepStatus;
  /** 失败时的错误信息。 */
  error?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

/** 计划整体进度摘要。 */
export interface ProgressSummary {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  inProgress: number;
  pending: number;
  /** 当前正在执行的步骤编号；无则为 null。 */
  current: number | null;
  /** 各步骤详细状态。 */
  steps: StepState[];
}

// ── 进度管理器 ──

export class PlanProgress {
  private states: Map<number, StepState>;
  private callback: ProgressCallback | null = null;

  constructor(analysis: DepsAnalysis, onProgress?: ProgressCallback) {
    this.states = new Map(
      analysis.steps.map((step) => [step.index, { step, status: 'pending' as StepStatus }]),
    );
    this.callback = onProgress ?? null;
  }

  /** 注册进度回调（TUI 订阅）。 */
  onProgress(callback: ProgressCallback): void {
    this.callback = callback;
  }

  /** 标记步骤开始执行。 */
  startStep(index: number): void {
    const state = this.states.get(index);
    if (state === undefined || state.status !== 'pending') {
      return;
    }
    const from = state.status;
    state.status = 'in_progress';
    state.startedAt = Date.now();
    this.emit({ stepIndex: index, from, to: 'in_progress' });
  }

  /** 标记步骤完成。 */
  completeStep(index: number): void {
    const state = this.states.get(index);
    if (state === undefined) {
      return;
    }
    const from = state.status;
    state.status = 'completed';
    state.finishedAt = Date.now();
    this.emit({ stepIndex: index, from, to: 'completed' });
  }

  /** 标记步骤失败（提供错误信息）。 */
  failStep(index: number, error: string): void {
    const state = this.states.get(index);
    if (state === undefined) {
      return;
    }
    const from = state.status;
    state.status = 'failed';
    state.error = error;
    state.finishedAt = Date.now();
    this.emit({ stepIndex: index, from, to: 'failed', error });
  }

  /** 标记步骤跳过。 */
  skipStep(index: number, reason?: string): void {
    const state = this.states.get(index);
    if (state === undefined) {
      return;
    }
    const from = state.status;
    state.status = 'skipped';
    state.error = reason;
    this.emit({ stepIndex: index, from, to: 'skipped', error: reason });
  }

  /** 获取计划整体进度摘要。 */
  summary(): ProgressSummary {
    const steps: StepState[] = [...this.states.values()].sort(
      (a, b) => a.step.index - b.step.index,
    );
    const summary: ProgressSummary = {
      total: steps.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      inProgress: 0,
      pending: 0,
      current: null,
      steps,
    };

    for (const s of steps) {
      switch (s.status) {
        case 'completed':
          summary.completed += 1;
          break;
        case 'failed':
          summary.failed += 1;
          break;
        case 'skipped':
          summary.skipped += 1;
          break;
        case 'in_progress':
          summary.inProgress += 1;
          summary.current = s.step.index;
          break;
        case 'pending':
          summary.pending += 1;
          break;
      }
    }

    return summary;
  }

  /** 是否所有步骤已完成（含跳过）？ */
  get isFinished(): boolean {
    const s = this.summary();
    return s.pending === 0 && s.inProgress === 0;
  }

  /** 获取指定步骤的当前状态。 */
  getState(index: number): StepState | undefined {
    return this.states.get(index);
  }

  /** 获取下一步待执行的步骤编号（按拓扑顺序），无则 null。 */
  nextPending(ordered: number[]): number | null {
    for (const index of ordered) {
      const state = this.states.get(index);
      if (state?.status === 'pending') {
        return index;
      }
    }
    return null;
  }

  // ── 内部 ──

  private emit(event: ProgressEvent): void {
    this.callback?.(event);
  }
}
