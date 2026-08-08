/**
 * 会话主循环（顺序版）：消息组装 → 模型调用 → 工具分发 → 结果回填。
 *
 * 优化 v1.1：达到 MAX_LOOP_TURNS 时不再抛错，改为返回 { messages, interrupted: true }，
 * 保留已累积的工具调用结果与对话历史，调用方可让用户继续输入以延续工作。
 *
 * - 单次 runLoop = 「一轮用户输入 → 最终回复」，返回 RunLoopResult（含 messages + interrupted 标志）；
 *   调用方（TUI / run 模式）持有历史并继续下一轮，也便于持久化；
 * - 工具调度：parallelSafe 工具组内并行执行，审批类（edit/shell）独立串行；
 *   事件与消息回填保持原始调用顺序；
 * - 工具结果按长度截断回填（防上下文膨胀）；工具失败不中断循环，回填错误让模型自行修正；
 * - 模型调用失败（网络/鉴权等）直接上抛，由调用方展示；
 * - 流中中断/断流（Ctrl+C / 网络断开）：保留已生成内容回填会话，错误经 error 事件上报，不自动重连；
 * - 工具循环超过 MAX_LOOP_TURNS：返回 { messages, interrupted: true }，不抛错，已累积结果全部保留。
 */

import type { ModelClient, Usage } from '../model/client';
import type { ToolContext, ToolRegistry, ToolResult } from '../tools/registry';
import { toApiTools } from '../tools/registry';
import { compressContext } from './context';
import {
  assistantMessage,
  formatToolResult,
  systemMessage,
  toApiMessages,
  toolResultMessage,
  userMessage,
} from './messages';
import type { ChatMessage, ToolCall } from './types';

/** 单次输入允许的最大工具循环轮数。 */
export const MAX_LOOP_TURNS = 50;

/** 可修复工具失败允许的最大累计次数（超过即终止，T3.2 修复管线）。 */
export const MAX_REPAIRS = 2;

export interface LoopOptions {
  model: string;
  client: ModelClient;
  registry: ToolRegistry;
  ctx: ToolContext;
  /** 注入系统提示（项目规则等）；history 已有 system 消息时不重复注入。 */
  systemPrompt?: string;
  /** 事件回调（TUI 订阅流式输出 / 工具调用进度）。 */
  onEvent?: (event: LoopEvent) => void;
  /** 外部中断信号：流式中断/断流时保留已生成内容；signal 触发的中断不重试。 */
  signal?: AbortSignal;
  /** 模型上下文窗口（token）：超过 80% 预算时自动裁剪发送给模型的旧消息。 */
  contextWindow?: number;
  /** 最大工具循环轮数（默认 MAX_LOOP_TURNS = 10；子代理可覆写为更小值）。 */
  maxTurns?: number;
  /** 最大可修复失败次数（默认 MAX_REPAIRS = 2；探索类子代理可设更高值）。 */
  maxRepairs?: number;
}

/** runLoop 返回结构：完整消息历史 + 是否因达到轮数上限而中断。 */
export interface RunLoopResult {
  /** 更新后的完整消息历史（含本轮新增的所有消息）。 */
  messages: ChatMessage[];
  /** true = 达到 MAX_LOOP_TURNS 上限，工具循环被截断（已有结果保留）。 */
  interrupted: boolean;
}

export type LoopEvent =
  | { type: 'chunk'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCall: ToolCall; result: ToolResult }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: Error };

/**
 * 运行一轮会话。返回更新后的完整消息历史：
 * history（不含重复 system）+ 本轮 user 输入 + assistant 回复（+ 工具消息链）。
 */
export async function runLoop(
  options: LoopOptions,
  history: ChatMessage[],
  input: string,
): Promise<RunLoopResult> {
  const messages = [...history];
  if (options.systemPrompt !== undefined && !messages.some((m) => m.role === 'system')) {
    messages.unshift(systemMessage(options.systemPrompt));
  }
  messages.push(userMessage(input));

  // 修复管线计数跨轮共享：一次 runLoop 内可修复失败累计（T3.2）
  const repairState: RepairState = { count: 0 };
  const maxTurns = options.maxTurns ?? MAX_LOOP_TURNS;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const assistant = await streamAssistantReply(options, messages);
    messages.push(assistant);

    // 用户已中断（Ctrl+C）→ 保留已生成内容，不再执行后续工具
    if (options.signal?.aborted) {
      return { messages, interrupted: false };
    }

    const calls = assistant.toolCalls ?? [];
    if (calls.length === 0) {
      return { messages, interrupted: false };
    }

    for (const group of groupToolCalls(calls, options.registry)) {
      // 每组执行前再检查一次中断信号
      if (options.signal?.aborted) {
        return { messages, interrupted: false };
      }
      await executeGroup(options, group, messages, repairState);
    }
  }

  return { messages, interrupted: true };
}

/** 修复管线状态：可修复失败的累计次数（跨并行组共享）。 */
interface RepairState {
  count: number;
}

/**
 * 按并行安全分组：连续的 parallelSafe 工具聚合为一组（并行执行），
 * 不可并行工具（审批类）各自独立成组（串行，阻塞前后组的并行）。
 */
function groupToolCalls(calls: ToolCall[], registry: ToolRegistry): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let current: ToolCall[] = [];
  for (const call of calls) {
    const spec = registry.get(call.name);
    if (spec?.parallelSafe === true) {
      current.push(call);
    } else {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      groups.push([call]);
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/**
 * 执行一组工具：tool_call 事件按序先行发出，组内并行执行，
 * 完成后按原始顺序回填 tool_result 事件与 tool 消息（与 tool_calls 顺序一致）。
 */
async function executeGroup(
  options: LoopOptions,
  group: ToolCall[],
  messages: ChatMessage[],
  repairState: RepairState,
): Promise<void> {
  // 中断信号已触发 → 跳过工具执行
  if (options.signal?.aborted) {
    return;
  }
  for (const call of group) {
    options.onEvent?.({ type: 'tool_call', toolCall: call });
  }
  const results = await Promise.all(group.map((call) => executeToolCall(options, call)));
  for (let i = 0; i < group.length; i += 1) {
    const call = group[i];
    const result = results[i];
    if (call === undefined || result === undefined) {
      continue;
    }
    options.onEvent?.({ type: 'tool_result', toolCall: call, result });
    messages.push(toolResultMessage(call.id, formatToolResult(result, call.name)));
    // 修复管线：可修复失败累计超限即终止（审批拒绝/越界等 repairable: false 不计数）
    if (result.ok === false && result.repairable !== false) {
      repairState.count += 1;
      const maxRepairs = options.maxRepairs ?? MAX_REPAIRS;
      if (repairState.count > maxRepairs) {
        throw new Error(
          `工具调用连续失败 ${repairState.count} 次（可修复错误，上限 ${maxRepairs}），已终止`,
        );
      }
    }
  }
}

/** 执行单个工具调用：参数解析失败转为 ok:false 结构化结果。 */
async function executeToolCall(options: LoopOptions, call: ToolCall): Promise<ToolResult> {
  try {
    const args = JSON.parse(call.arguments) as unknown;
    return await options.registry.run(call.name, args, options.ctx);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 调用模型并流式累积出一条完整的 assistant 消息（含 tool_calls 增量拼接）。 */
async function streamAssistantReply(
  options: LoopOptions,
  messages: ChatMessage[],
): Promise<ChatMessage> {
  let content = '';
  const toolCallAcc = new Map<number, { id: string; name: string; args: string }>();
  /** 最后一个带 usage 的 chunk（DeepSeek 在流末尾 chunk 返回用量统计）。 */
  let lastUsage: Usage | undefined;

  // 发送前按上下文窗口预算压缩（v2.0：优先摘要，失败回退裁剪）
  let toSend: ChatMessage[];
  if (options.contextWindow !== undefined) {
    const result = await compressContext(messages, {
      client: options.client,
      model: options.model,
      contextWindow: options.contextWindow,
    });
    toSend = result.messages;
  } else {
    toSend = messages;
  }

  const apiTools = toApiTools(options.registry.list());

  try {
    for await (const chunk of options.client.streamChat({
      model: options.model,
      messages: toApiMessages(toSend),
      tools: apiTools,
      signal: options.signal,
    })) {
      if (chunk.usage != null) {
        lastUsage = chunk.usage;
      }
      for (const choice of chunk.choices) {
        const delta = choice.delta;
        const text = delta.content ?? '';
        if (text !== '') {
          content += text;
          options.onEvent?.({ type: 'chunk', text });
        }
        for (const piece of delta.tool_calls ?? []) {
          const acc = toolCallAcc.get(piece.index) ?? { id: '', name: '', args: '' };
          if (piece.id !== undefined) {
            acc.id = piece.id;
          }
          if (piece.function?.name !== undefined) {
            acc.name += piece.function.name;
          }
          if (piece.function?.arguments !== undefined) {
            acc.args += piece.function.arguments;
          }
          toolCallAcc.set(piece.index, acc);
        }
      }
    }
  } catch (error) {
    // 断流/中断：保留已生成内容回填会话，错误经 error 事件上报，不自动重连；
    // 尚无任何内容时原样上抛，由调用方展示。
    const err = error instanceof Error ? error : new Error(String(error));
    if (content !== '') {
      options.onEvent?.({ type: 'error', error: err });
      return assistantMessage(content);
    }
    throw err;
  }

  if (lastUsage !== undefined) {
    options.onEvent?.({ type: 'usage', usage: lastUsage });
  }

  const toolCalls: ToolCall[] = [...toolCallAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, acc]) => acc.name !== '')
    .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: acc.args }));

  return assistantMessage(content, toolCalls.length > 0 ? toolCalls : undefined);
}
