/**
 * 会话主循环（顺序版）：消息组装 → 模型调用 → 工具分发 → 结果回填。
 *
 * - 单次 runLoop = 「一轮用户输入 → 最终回复」，返回完整消息历史（含本轮新增），
 *   调用方（TUI / run 模式）持有历史并继续下一轮，也便于持久化；
 * - 工具调用按序执行（并行调度留 v0.2，registry 已保留 parallelSafe 字段位）；
 * - 工具结果按长度截断回填（防上下文膨胀）；工具失败不中断循环，回填错误让模型自行修正；
 * - 模型调用失败（网络/鉴权等）直接上抛，由调用方展示；
 * - 流中中断/断流（Ctrl+C / 网络断开）：保留已生成内容回填会话，错误经 error 事件上报，不自动重连；
 * - 工具循环超过 MAX_LOOP_TURNS 视为失控，抛错终止。
 */

import type { ModelClient, Usage } from '../model/client';
import type { ToolContext, ToolRegistry, ToolResult } from '../tools/registry';
import { trimContext } from './context';
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
export const MAX_LOOP_TURNS = 10;

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
): Promise<ChatMessage[]> {
  const messages = [...history];
  if (options.systemPrompt !== undefined && !messages.some((m) => m.role === 'system')) {
    messages.unshift(systemMessage(options.systemPrompt));
  }
  messages.push(userMessage(input));

  for (let turn = 0; turn < MAX_LOOP_TURNS; turn += 1) {
    const assistant = await streamAssistantReply(options, messages);
    messages.push(assistant);

    const calls = assistant.toolCalls ?? [];
    if (calls.length === 0) {
      return messages;
    }

    for (const call of calls) {
      options.onEvent?.({ type: 'tool_call', toolCall: call });
      let result: ToolResult;
      try {
        const args = JSON.parse(call.arguments) as unknown;
        result = await options.registry.run(call.name, args, options.ctx);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      options.onEvent?.({ type: 'tool_result', toolCall: call, result });
      messages.push(toolResultMessage(call.id, formatToolResult(result, call.name)));
    }
  }

  throw new Error(`工具循环超过最大轮数 ${MAX_LOOP_TURNS}，已终止`);
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

  // 发送前按上下文窗口预算裁剪（仅发送视角；messages 本体保持不变）
  const toSend =
    options.contextWindow !== undefined
      ? trimContext(messages, options.contextWindow).messages
      : messages;

  try {
    for await (const chunk of options.client.streamChat({
      model: options.model,
      messages: toApiMessages(toSend),
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
