/**
 * 任务状态机测试（v3.0 M2 / T2.1）。
 *
 * 覆盖验收标准：
 * - 状态转换图：pending → in_progress → awaiting_review → awaiting_qa → completed/failed
 *   （含 reject/QA 失败打回 in_progress、任意非终止态 → failed）；
 * - 守卫：未满足依赖（依赖未完成 / 状态未知 / 未配置查询）不可进入 in_progress；
 * - 非法转换抛 InvalidTransitionError 并记录 violations（如 awaiting_qa → pending）；
 * - canTransition(from, to) 查询 + transition(task, to, reason) 执行；
 * - 状态变更事件可订阅（onTransition / 取消订阅 / 多监听器 / 监听器异常不阻断）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_VIOLATIONS,
  InvalidTransitionError,
  isTerminalStatus,
  type TaskStateChange,
  TaskStateMachine,
  type TaskStateRecord,
  TRANSITIONS,
  TransitionGuardError,
} from '../../src/orchestrator';

// ── 工具 ──────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskStateRecord> = {}): TaskStateRecord {
  return {
    id: 'task-1',
    dependencies: [],
    status: 'pending',
    agent: '',
    ...overrides,
  };
}

/** 构造状态机；statusMap 提供依赖状态查询（undefined 表示依赖不存在/未知）。 */
function makeMachine(
  statusMap?: Record<string, TaskStateRecord['status'] | undefined>,
): TaskStateMachine {
  return new TaskStateMachine({ getTaskStatus: (id) => statusMap?.[id] });
}

// ── 状态转换图 ────────────────────────────────────────────────

describe('状态转换图（TRANSITIONS）', () => {
  it('覆盖主流程：pending → in_progress → awaiting_review → awaiting_qa → completed', () => {
    expect(TRANSITIONS).toContainEqual({ from: 'pending', to: 'in_progress' });
    expect(TRANSITIONS).toContainEqual({ from: 'in_progress', to: 'awaiting_review' });
    expect(TRANSITIONS).toContainEqual({ from: 'awaiting_review', to: 'awaiting_qa' });
    expect(TRANSITIONS).toContainEqual({ from: 'awaiting_qa', to: 'completed' });
  });

  it('支持打回修复：awaiting_review → in_progress（reject）、awaiting_qa → in_progress（QA 失败）', () => {
    expect(TRANSITIONS).toContainEqual({ from: 'awaiting_review', to: 'in_progress' });
    expect(TRANSITIONS).toContainEqual({ from: 'awaiting_qa', to: 'in_progress' });
  });

  it('任意非终止态可失败：pending/in_progress/awaiting_review/awaiting_qa → failed', () => {
    for (const from of ['pending', 'in_progress', 'awaiting_review', 'awaiting_qa'] as const) {
      expect(TRANSITIONS).toContainEqual({ from, to: 'failed' });
    }
  });

  it('completed / failed 为终止态，无出边', () => {
    const outEdges = TRANSITIONS.filter((t) => t.from === 'completed' || t.from === 'failed');
    expect(outEdges).toEqual([]);
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('in_progress')).toBe(false);
  });
});

// ── canTransition（图查询，验收标准 #4）───────────────────────

describe('canTransition(from, to) 图查询', () => {
  it('图中合法转换返回 true', () => {
    const m = makeMachine();
    expect(m.canTransition('pending', 'in_progress')).toBe(true);
    expect(m.canTransition('in_progress', 'awaiting_review')).toBe(true);
    expect(m.canTransition('awaiting_review', 'awaiting_qa')).toBe(true);
    expect(m.canTransition('awaiting_review', 'in_progress')).toBe(true);
    expect(m.canTransition('awaiting_qa', 'completed')).toBe(true);
    expect(m.canTransition('awaiting_qa', 'in_progress')).toBe(true);
    expect(m.canTransition('pending', 'failed')).toBe(true);
    expect(m.canTransition('in_progress', 'failed')).toBe(true);
  });

  it('图中非法转换返回 false（如 awaiting_qa → pending 拒绝）', () => {
    const m = makeMachine();
    expect(m.canTransition('awaiting_qa', 'pending')).toBe(false);
    expect(m.canTransition('completed', 'in_progress')).toBe(false);
    expect(m.canTransition('failed', 'pending')).toBe(false);
    expect(m.canTransition('pending', 'completed')).toBe(false);
    expect(m.canTransition('awaiting_review', 'pending')).toBe(false);
  });

  it('TRANSITIONS 与 canTransition 一致（无孤儿边）', () => {
    const m = makeMachine();
    for (const { from, to } of TRANSITIONS) {
      expect(m.canTransition(from, to)).toBe(true);
    }
  });
});

// ── 守卫：依赖检查（验收标准 #2）──────────────────────────────

describe('pending → in_progress 守卫（依赖必须全部 completed）', () => {
  it('无依赖任务直接放行', () => {
    const m = makeMachine();
    const task = makeTask({ dependencies: [] });
    expect(m.canTransitionTask(task, 'in_progress').allowed).toBe(true);
    expect(() => m.transition(task, 'in_progress')).not.toThrow();
    expect(task.status).toBe('in_progress');
  });

  it('依赖全部 completed 放行', () => {
    const m = makeMachine({ 'dep-1': 'completed', 'dep-2': 'completed' });
    const task = makeTask({ dependencies: ['dep-1', 'dep-2'] });
    expect(m.canTransitionTask(task, 'in_progress').allowed).toBe(true);
    expect(() => m.transition(task, 'in_progress')).not.toThrow();
  });

  it('依赖未完成 → 守卫拒绝（TransitionGuardError + 原因）', () => {
    const m = makeMachine({ 'dep-1': 'completed', 'dep-2': 'in_progress' });
    const task = makeTask({ dependencies: ['dep-1', 'dep-2'] });
    const check = m.canTransitionTask(task, 'in_progress');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('依赖任务未完成');
    expect(() => m.transition(task, 'in_progress')).toThrow(TransitionGuardError);
  });

  it('依赖任务不存在/状态未知 → 守卫拒绝（fail-closed）', () => {
    const m = makeMachine({ 'dep-1': 'completed' });
    const task = makeTask({ dependencies: ['dep-1', 'ghost'] });
    const check = m.canTransitionTask(task, 'in_progress');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('不存在或状态未知');
    expect(() => m.transition(task, 'in_progress')).toThrow(TransitionGuardError);
  });

  it('存在依赖但未配置 getTaskStatus → 守卫拒绝（fail-closed）', () => {
    const m = new TaskStateMachine(); // 无 getTaskStatus
    const task = makeTask({ dependencies: ['dep-1'] });
    const check = m.canTransitionTask(task, 'in_progress');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('未配置 getTaskStatus');
    expect(() => m.transition(task, 'in_progress')).toThrow(TransitionGuardError);
  });

  it('守卫只作用于 pending → in_progress，其他转换不受影响', () => {
    const m = makeMachine();
    const task = makeTask({ status: 'in_progress', dependencies: ['未完成依赖'] });
    // in_progress → awaiting_review 无依赖守卫
    expect(m.canTransitionTask(task, 'awaiting_review').allowed).toBe(true);
    expect(() => m.transition(task, 'awaiting_review')).not.toThrow();
  });
});

// ── transition 执行（验收标准 #3/#4）──────────────────────────

describe('transition(task, to, options) 执行', () => {
  it('正常转换更新任务状态并返回 TaskStateChange（含 from/to/reason/timestamp）', () => {
    const m = makeMachine();
    const task = makeTask();
    const change = m.transition(task, 'in_progress', { reason: '调度器启动', agent: 'coder' });
    expect(task.status).toBe('in_progress');
    expect(task.agent).toBe('coder');
    expect(change.taskId).toBe('task-1');
    expect(change.from).toBe('pending');
    expect(change.to).toBe('in_progress');
    expect(change.reason).toBe('调度器启动');
    expect(typeof change.timestamp).toBe('number');
  });

  it('完整闭环路径可连续转换：pending → … → completed', () => {
    const m = makeMachine();
    const task = makeTask();
    m.transition(task, 'in_progress');
    m.transition(task, 'awaiting_review', { reason: 'coder 提交' });
    m.transition(task, 'awaiting_qa', { reason: 'reviewer approve' });
    m.transition(task, 'completed', { reason: 'qa 全绿' });
    expect(task.status).toBe('completed');
  });

  it('reject / QA 失败打回路径：awaiting_review → in_progress / awaiting_qa → in_progress', () => {
    const m = makeMachine();
    const task = makeTask();
    m.transition(task, 'in_progress');
    m.transition(task, 'awaiting_review');
    m.transition(task, 'in_progress', { reason: 'reviewer reject' }); // 打回
    m.transition(task, 'awaiting_review');
    m.transition(task, 'awaiting_qa', { reason: 'reviewer approve' });
    m.transition(task, 'in_progress', { reason: 'qa 失败' }); // 打回
    expect(task.status).toBe('in_progress');
  });

  it('非法转换抛 InvalidTransitionError（如 awaiting_qa → pending）并携带上下文', () => {
    const m = makeMachine();
    const task = makeTask({ status: 'awaiting_qa' });
    let caught: InvalidTransitionError | undefined;
    try {
      m.transition(task, 'pending');
    } catch (err) {
      caught = err as InvalidTransitionError;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    expect(caught?.taskId).toBe('task-1');
    expect(caught?.from).toBe('awaiting_qa');
    expect(caught?.to).toBe('pending');
    expect(caught?.message).toContain('不在状态转换图中');
    expect(task.status).toBe('awaiting_qa'); // 状态不变
  });

  it('终止态不可再转换（completed → in_progress 抛错）', () => {
    const m = makeMachine();
    const task = makeTask({ status: 'completed' });
    expect(() => m.transition(task, 'in_progress')).toThrow(InvalidTransitionError);
  });

  it('非法转换记录到 violations（含 taskId/from/to/reason）', () => {
    const m = makeMachine();
    const task = makeTask({ status: 'awaiting_qa' });
    expect(() => m.transition(task, 'pending')).toThrow();
    const violations = m.violations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.taskId).toBe('task-1');
    expect(violations[0]?.from).toBe('awaiting_qa');
    expect(violations[0]?.to).toBe('pending');
    expect(violations[0]?.reason).toContain('非法状态转换');
    expect(typeof violations[0]?.timestamp).toBe('number');
  });

  it('守卫拒绝也记录到 violations', () => {
    const m = makeMachine({ 'dep-1': 'pending' });
    const task = makeTask({ dependencies: ['dep-1'] });
    expect(() => m.transition(task, 'in_progress')).toThrow(TransitionGuardError);
    const violations = m.violations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.to).toBe('in_progress');
    expect(violations[0]?.reason).toContain('依赖任务未完成');
  });
});

// ── 事件订阅（验收标准 #5）────────────────────────────────────

describe('onTransition 事件订阅', () => {
  it('转换成功后监听器收到 TaskStateChange', () => {
    const m = makeMachine();
    const task = makeTask();
    const received: TaskStateChange[] = [];
    m.onTransition((change) => received.push(change));
    m.transition(task, 'in_progress', { reason: '启动' });
    expect(received).toHaveLength(1);
    expect(received[0]?.taskId).toBe('task-1');
    expect(received[0]?.from).toBe('pending');
    expect(received[0]?.to).toBe('in_progress');
    expect(received[0]?.reason).toBe('启动');
  });

  it('取消订阅后不再收到事件', () => {
    const m = makeMachine();
    const task = makeTask();
    const received: TaskStateChange[] = [];
    const unsubscribe = m.onTransition((change) => received.push(change));
    m.transition(task, 'in_progress');
    expect(received).toHaveLength(1);
    unsubscribe();
    m.transition(task, 'awaiting_review');
    expect(received).toHaveLength(1); // 未再增加
  });

  it('多个监听器都收到事件', () => {
    const m = makeMachine();
    const task = makeTask();
    const a: TaskStateChange[] = [];
    const b: TaskStateChange[] = [];
    m.onTransition((c) => a.push(c));
    m.onTransition((c) => b.push(c));
    m.transition(task, 'in_progress');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('监听器抛错不阻断状态机主流程（状态仍更新，事件正常返回）', () => {
    const m = makeMachine();
    const task = makeTask();
    m.onTransition(() => {
      throw new Error('订阅方异常');
    });
    const change = m.transition(task, 'in_progress');
    expect(task.status).toBe('in_progress');
    expect(change.to).toBe('in_progress');
  });

  it('非法转换不触发事件（仅成功转换发事件）', () => {
    const m = makeMachine();
    const task = makeTask({ status: 'awaiting_qa' });
    let fired = 0;
    m.onTransition(() => {
      fired += 1;
    });
    expect(() => m.transition(task, 'pending')).toThrow();
    expect(fired).toBe(0);
  });
});

// ── violations 上限 ───────────────────────────────────────────

describe('violations 记录上限', () => {
  it('超过 maxViolations 时保留最近记录（截断旧记录）', () => {
    const m = new TaskStateMachine({ maxViolations: 2 });
    const task = makeTask({ status: 'awaiting_qa' });
    for (let i = 0; i < 3; i += 1) {
      expect(() => m.transition(task, 'pending')).toThrow();
    }
    const violations = m.violations();
    expect(violations).toHaveLength(2);
    // 保留最近两次（前 1 条被截断）
    expect(violations[0]?.to).toBe('pending');
    expect(violations[1]?.to).toBe('pending');
  });

  it('默认上限为 DEFAULT_MAX_VIOLATIONS', () => {
    expect(DEFAULT_MAX_VIOLATIONS).toBe(100);
    const m = new TaskStateMachine();
    expect(m.violations()).toEqual([]);
  });
});
