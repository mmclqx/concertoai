/**
 * 可观测性面板测试（v3.0 M5 / T5.3）。
 *
 * 覆盖验收标准：
 * - open=false 时不渲染（不阻塞主对话流）；
 * - open=true 渲染流程树：节点含任务/Agent/状态/耗时，父子缩进；
 * - 空数据时显示占位提示；
 * - 性能基准（§6.1）：50 个节点渲染 < 100ms（ink-testing-library 断言）。
 */
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { TraceSpan } from '../../src/observable';
import { ObservabilityPanel } from '../../src/ui/ObservabilityPanel';

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: 'span-1',
    taskId: 't1',
    agentName: 'architect',
    messageType: 'result',
    input: { data: 'input' },
    output: { data: 'output' },
    startedAt: 1_000,
    durationMs: 42,
    ...overrides,
  };
}

describe('ObservabilityPanel 渲染', () => {
  it('open=false 不渲染任何内容（不阻塞主对话流）', () => {
    const { lastFrame } = render(<ObservabilityPanel spans={[makeSpan()]} open={false} />);
    expect(lastFrame()).toBe('');
  });

  it('open=true 渲染流程树：任务/Agent/状态/耗时', () => {
    const spans = [
      makeSpan({
        id: 'root',
        taskId: 't0',
        agentName: 'orchestrator',
        messageType: 'task',
        durationMs: 10,
        decision: 'completed',
      }),
      makeSpan({
        id: 'child',
        taskId: 't1',
        parentTaskId: 't0',
        agentName: 'architect',
        messageType: 'result',
        durationMs: 42,
      }),
    ];
    const { lastFrame } = render(<ObservabilityPanel spans={spans} open={true} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('📡');
    expect(frame).toContain('t0');
    expect(frame).toContain('orchestrator');
    expect(frame).toContain('architect');
    expect(frame).toContain('42ms');
    expect(frame).toContain('completed');
  });

  it('空数据时显示占位提示', () => {
    const { lastFrame } = render(<ObservabilityPanel spans={[]} open={true} />);
    expect(lastFrame()).toContain('暂无追踪数据');
  });
});

describe('ObservabilityPanel 性能基准（§6.1）', () => {
  it('50 个节点流程树渲染 < 100ms', () => {
    const spans: TraceSpan[] = [];
    for (let i = 0; i < 50; i++) {
      spans.push(
        makeSpan({
          id: `span-${i}`,
          taskId: `task-${i}`,
          parentTaskId: i > 0 ? `task-${i - 1}` : undefined,
          agentName: i % 2 === 0 ? 'architect' : 'coder',
          durationMs: i,
        }),
      );
    }
    const start = performance.now();
    const { lastFrame, unmount } = render(<ObservabilityPanel spans={spans} open={true} />);
    const elapsed = performance.now() - start;
    expect(lastFrame()).toContain('50 条记录');
    expect(elapsed).toBeLessThan(100);
    unmount();
  });
});
