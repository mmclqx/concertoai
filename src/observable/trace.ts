/**
 * 调用链追踪（v3.0 M5 / T5.1）。
 *
 * 记录每个 Agent 的输入/输出/决策/耗时，支持按 taskId 查询完整调用链
 * （含父子任务树），供可观测性面板（T5.3）与审计日志（T5.2）消费。
 *
 * 关键设计：
 * - TraceStore 为内存 LRU（默认上限 5000 条），防无限增长（对齐 v2.1 知识图谱 LRU 风格）；
 * - record() 由编排层在 AgentMessage 收发时调用（输入/输出/耗时）；
 * - subscribeToStateMachine() 订阅 T2.1 状态机的 onTransition，状态变更自动记录为
 *   decision span（taskId/from/to/reason 可追溯）；
 * - queryByTaskId() 支持父子任务树：span 携带 parentTaskId 时，查询会递归收集子任务 spans。
 */

import type { AgentMessageType, TaskStateChange, TaskStateMachine } from '../orchestrator';

/** 单个追踪跨度：一条消息或一次状态变更的完整记录。 */
export interface TraceSpan {
  /** 跨度 ID（消息场景与 AgentMessage.id 对齐；状态场景为 state:<taskId>:<ts>）。 */
  id: string;
  /** 归属任务 ID。 */
  taskId: string;
  /** 父任务 ID（子任务场景，来自 AgentContext.parentTaskId）。 */
  parentTaskId?: string;
  /** 产生该跨度的 Agent 名称（状态变更场景为 'state-machine'）。 */
  agentName: string;
  /** 消息类型（消息场景）或 'state-change'（状态变更场景）。 */
  messageType: AgentMessageType | 'state-change';
  /** 输入摘要（task 描述 / from/to 状态等）。 */
  input: unknown;
  /** 输出摘要（result / 决策结果，可选）。 */
  output?: unknown;
  /** 决策说明（如状态变更 reason：'reviewer approve' / 'qa failed'）。 */
  decision?: string;
  /** 开始时间戳（epoch 毫秒）。 */
  startedAt: number;
  /** 耗时（毫秒）。 */
  durationMs: number;
}

/** 追踪记录默认上限（LRU 淘汰，防无限增长）。 */
export const DEFAULT_TRACE_LIMIT = 5_000;

/**
 * 内存 LRU 调用链追踪存储。
 * 单线程 JS 天然安全；Map 迭代序即插入序，淘汰最旧记录。
 */
export class TraceStore {
  private readonly spans = new Map<string, TraceSpan>();
  private readonly limit: number;

  constructor(limit: number = DEFAULT_TRACE_LIMIT) {
    this.limit = limit;
  }

  /** 记录一个跨度（同 id 覆盖；超上限淘汰最旧）。 */
  record(span: TraceSpan): void {
    this.spans.delete(span.id); // 保持插入序（覆盖时移到末尾）
    this.spans.set(span.id, span);
    while (this.spans.size > this.limit) {
      const oldest = this.spans.keys().next().value;
      if (oldest === undefined) break;
      this.spans.delete(oldest);
    }
  }

  /** 当前记录数。 */
  size(): number {
    return this.spans.size;
  }

  /** 全部跨度（按记录顺序）。 */
  all(): TraceSpan[] {
    return [...this.spans.values()];
  }

  /**
   * 按 taskId 查询完整调用链（含子任务，递归收集 parentTaskId 关联）。
   * 返回按记录顺序排列的跨度列表。
   */
  queryByTaskId(taskId: string): TraceSpan[] {
    const result: TraceSpan[] = [];
    const visit = (tid: string): void => {
      for (const span of this.spans.values()) {
        if (span.taskId === tid) {
          result.push(span);
        } else if (span.parentTaskId === tid) {
          visit(span.taskId);
        }
      }
    };
    visit(taskId);
    return result;
  }

  /**
   * 订阅状态机状态变更：每次 transition 自动记录为 decision span。
   * @returns 取消订阅函数
   */
  subscribeToStateMachine(sm: TaskStateMachine): () => void {
    return sm.onTransition((change: TaskStateChange) => {
      this.record({
        id: `state:${change.taskId}:${change.timestamp}`,
        taskId: change.taskId,
        agentName: 'state-machine',
        messageType: 'state-change',
        input: { from: change.from, to: change.to },
        decision: change.reason,
        startedAt: change.timestamp,
        durationMs: 0,
      });
    });
  }
}
