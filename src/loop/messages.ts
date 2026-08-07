/**
 * 消息构造与序列化：会话层 ChatMessage ⇄ API 线格式 ApiMessage。
 */

import type { ApiMessage } from '../model/client';
import type { ToolResult } from '../tools/registry';
import type { ChatMessage, ToolCall } from './types';

export function systemMessage(content: string): ChatMessage {
  return { role: 'system', content };
}

export function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

export function assistantMessage(content: string, toolCalls?: ToolCall[]): ChatMessage {
  return { role: 'assistant', content, ...(toolCalls !== undefined ? { toolCalls } : {}) };
}

export function toolResultMessage(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', toolCallId, content };
}

/** 会话消息 → API 线格式（assistant 携带 tool_calls、tool 消息携带 tool_call_id）。 */
export function toApiMessages(messages: ChatMessage[]): ApiMessage[] {
  return messages.map((m) => {
    const api: ApiMessage = { role: m.role, content: m.content };
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      api.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (m.role === 'tool' && m.toolCallId !== undefined) {
      api.tool_call_id = m.toolCallId;
    }
    return api;
  });
}

/** 工具结果回填的最大字符数（防上下文膨胀）。 */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/** 工具执行结果 → 回填给模型的文本。 */
export function formatToolResult(result: ToolResult, toolName: string): string {
  if (!result.ok) {
    return `工具 ${toolName} 执行失败: ${result.error ?? '未知错误'}`;
  }
  const text = JSON.stringify(result.data);
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…（结果已截断，共 ${text.length} 字符）`;
  }
  return text;
}
