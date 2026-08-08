/**
 * 计划进度跟踪单元测试。
 */

import { describe, expect, it } from 'vitest';

import { analyzeDeps } from '../../src/planner/deps';
import type { ProgressEvent } from '../../src/planner/progress';
import { PlanProgress } from '../../src/planner/progress';

describe('PlanProgress 状态机', () => {
  const plan = ['1. 步骤一', '2. 步骤二', '3. 步骤三'].join('\n');

  it('初始状态全部 pending', () => {
    const analysis = analyzeDeps(plan);
    const progress = new PlanProgress(analysis);
    const summary = progress.summary();
    expect(summary.total).toBe(3);
    expect(summary.pending).toBe(3);
    expect(summary.completed).toBe(0);
  });

  it('startStep → completeStep 流转正确', () => {
    const analysis = analyzeDeps(plan);
    const progress = new PlanProgress(analysis);

    progress.startStep(1);
    expect(progress.getState(1)?.status).toBe('in_progress');

    progress.completeStep(1);
    expect(progress.getState(1)?.status).toBe('completed');
  });

  it('failStep 记录错误信息', () => {
    const analysis = analyzeDeps(plan);
    const progress = new PlanProgress(analysis);

    progress.startStep(1);
    progress.failStep(1, '连接超时');
    const state = progress.getState(1);
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('连接超时');
  });

  it('skipStep 跳过步骤', () => {
    const analysis = analyzeDeps(plan);
    const progress = new PlanProgress(analysis);

    progress.skipStep(2, '用户选择跳过');
    expect(progress.getState(2)?.status).toBe('skipped');
  });

  it('isFinished 全完成后返回 true', () => {
    const analysis = analyzeDeps(plan);
    const progress = new PlanProgress(analysis);

    progress.completeStep(1);
    progress.completeStep(2);
    progress.completeStep(3);
    expect(progress.isFinished).toBe(true);
  });

  it('summary 统计各状态数量', () => {
    const analysis = analyzeDeps(plan);
    const progress = new PlanProgress(analysis);

    progress.completeStep(1);
    progress.failStep(2, 'error');
    progress.skipStep(3);

    const s = progress.summary();
    expect(s.completed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.pending).toBe(0);
  });

  it('nextPending 返回拓扑顺序中第一个待执行步骤', () => {
    const analysis = analyzeDeps(plan);
    const progress = new PlanProgress(analysis);
    const ordered = [1, 2, 3];

    expect(progress.nextPending(ordered)).toBe(1);
    progress.completeStep(1);
    expect(progress.nextPending(ordered)).toBe(2);
  });
});

describe('PlanProgress 回调', () => {
  it('回调收到状态变更事件', () => {
    const analysis = analyzeDeps('1. 步骤一\n2. 步骤二');
    const events: ProgressEvent[] = [];
    const progress = new PlanProgress(analysis, (e) => events.push(e));

    progress.startStep(1);
    progress.completeStep(1);

    expect(events).toHaveLength(2);
    expect(events[0]?.stepIndex).toBe(1);
    expect(events[0]?.to).toBe('in_progress');
    expect(events[1]?.stepIndex).toBe(1);
    expect(events[1]?.to).toBe('completed');
  });
});
