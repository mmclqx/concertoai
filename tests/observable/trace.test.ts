/**
 * 调用链追踪测试（v3.0 M5 / T5.1）。
 *
 * 覆盖验收标准：
 * - record/queryByTaskId：按 taskId 查询完整调用链（含子任务树）；
 * - LRU 上限（默认 5000）：超限淘汰最旧记录；
 * - subscribeToStateMachine：订阅 T2.1 状态机 onTransition，状态变更自动记录为 decision span；
 * - 同 id 覆盖时保持插入序（覆盖移到末尾，LRU 语义正确）。
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_TRACE_LIMIT, type TraceSpan, TraceStore } from '../../src/observable';
import { TaskStateMachine } from '../../src/orchestrator';

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: 'msg-1',
    taskId: 't1',
    agentName: 'architect',
    messageType: 'result',
    input: { data: 'input' },
    output: { data: 'output' },
    startedAt: 1_000,
    durationMs: 5,
    ...overrides,
  };
}

describe('TraceStore 基础记录 / 查询', () => {
  it('record 后可 size/all 读取', () => {
    const store = new TraceStore();
    store.record(makeSpan());
    expect(store.size()).toBe(1);
    expect(store.all()[0]?.id).toBe('msg-1');
  });

  it('queryByTaskId 返回该任务全部跨度（含子任务，递归收集）', () => {
    const store = new TraceStore();
    store.record(makeSpan({ id: 'root', taskId: 't0' }));
    store.record(makeSpan({ id: 'child', taskId: 't1', parentTaskId: 't0' }));
    store.record(makeSpan({ id: 'grand', taskId: 't2', parentTaskId: 't1' }));
    store.record(makeSpan({ id: 'other', taskId: 't9' }));

    const chain = store.queryByTaskId('t0');
    const ids = chain.map((s) => s.id).sort();
    expect(ids).toEqual(['child', 'grand', 'root']);
  });

  it('同 id 覆盖时保持插入序（覆盖移到最后，LRU 语义）', () => {
    const store = new TraceStore();
    store.record(makeSpan({ id: 'a', taskId: 't1' }));
    store.record(makeSpan({ id: 'b', taskId: 't1' }));
    store.record(makeSpan({ id: 'a', taskId: 't1', output: { data: 'updated' } }));
    expect(store.all().map((s) => s.id)).toEqual(['b', 'a']);
    expect(store.all()[1]?.output).toEqual({ data: 'updated' });
  });
});

describe('TraceStore LRU 上限', () => {
  it('超上限淘汰最旧记录', () => {
    const store = new TraceStore(3);
    store.record(makeSpan({ id: '1' }));
    store.record(makeSpan({ id: '2' }));
    store.record(makeSpan({ id: '3' }));
    store.record(makeSpan({ id: '4' }));
    expect(store.size()).toBe(3);
    expect(store.all().map((s) => s.id)).toEqual(['2', '3', '4']);
  });

  it('默认上限为 DEFAULT_TRACE_LIMIT（5000）', () => {
    expect(DEFAULT_TRACE_LIMIT).toBe(5_000);
    const store = new TraceStore();
    for (let i = 0; i < 5_100; i++) {
      store.record(makeSpan({ id: `m${i}` }));
    }
    expect(store.size()).toBe(5_000);
    expect(store.all()[0]?.id).toBe('m100');
  });
});

describe('TraceStore 订阅状态机（T5.1 联动 T2.1）', () => {
  it('状态变更自动记录为 decision span，取消订阅后停止记录', () => {
    const sm = new TaskStateMachine({});
    const store = new TraceStore();
    const unsubscribe = store.subscribeToStateMachine(sm);

    // transition 从 task.status 读初始状态（就地更新），需带 status 字段
    // 合法路径：pending→in_progress→awaiting_review→awaiting_qa→completed
    const task = { id: 't1', dependencies: [], status: 'pending' as const };
    sm.transition(task, 'in_progress', { reason: '调度启动' });
    expect(store.size()).toBe(1);
    const span = store.all()[0];
    expect(span?.agentName).toBe('state-machine');
    expect(span?.messageType).toBe('state-change');
    expect(span?.input).toEqual({ from: 'pending', to: 'in_progress' });
    expect(span?.decision).toBe('调度启动');

    // 退订后走一步合法转换，断言不再记录
    unsubscribe();
    sm.transition(task, 'awaiting_review', { reason: 'reviewer 完成' });
    expect(store.size()).toBe(1); // 已退订，不再增长
  });
});
