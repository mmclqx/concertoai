/**
 * 消息构造与序列化：会话层 ChatMessage ⇄ API 线格式 ApiMessage。
 */

import type { ApiMessage } from '../model/client';
import { maskSecrets } from '../tools/read';
import type { ToolResult } from '../tools/registry';
import type { ChatMessage, ToolCall } from './types';

export function systemMessage(content: string): ChatMessage {
  return { role: 'system', content };
}

/** 构造摘要消息（v2.0 智能压缩）：以 system 角色注入对话摘要。 */
export function summaryMessage(summary: string): ChatMessage {
  return { role: 'system', content: `# 对话摘要\n${summary}` };
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

/**
 * 工具失败文本的**唯一标记**（v5.3 N4）。
 *
 * 为什么抽成常量：判断「这条 tool 消息是不是失败」（`isToolErrorContent`）与拼串
 * （`formatToolFailure`）必须同源。两处各写一份字面量时，改一处就会让交接单把
 * 失败的命令记成成功的——而那是**静默**的错，屏幕上看不出来。
 */
export const TOOL_ERROR_MARKER = ' 执行失败: ';

/** 拼失败文本（`formatToolResult` 与测试共用的唯一实现）。 */
export function formatToolFailure(toolName: string, error?: string): string {
  return `工具 ${toolName}${TOOL_ERROR_MARKER}${error ?? '未知错误'}`;
}

/**
 * 这条回填内容是否表示**工具执行失败**（v5.3 N4）。
 *
 * ## 为什么不能只判「包含标记」
 *
 * 成功结果里可能**合法地**含有这个标记：`read_file` 读到的文件内容若正好写着
 * 「工具 X 执行失败: 」（比如读的是本项目的 messages.ts 或踩坑记录），
 * 只判 `includes` 就会把一次成功读取记成失败 ⇒ 交接单给用户一条假的「下一步」。
 *
 * 故要求**同时**满足：① 以 `工具 ` 开头（`formatToolResult` 失败分支的唯一形态，
 * 成功分支是 `JSON.stringify` 的结果，以 `{` / `[` / `"` / 数字 开头）；
 * ② 同一行内出现标记（工具名不能跨行）。
 *
 * 双向自证见 `tests/cli/handoff.test.ts`：真失败文本 ⇒ true，真成功文本 ⇒ false，
 * 以及「成功内容里碰巧含标记」⇒ 仍 false。
 */
export function isToolErrorContent(content: string): boolean {
  if (!content.startsWith('工具 ')) {
    return false;
  }
  const at = content.indexOf(TOOL_ERROR_MARKER);
  return at > 0 && !content.slice(0, at).includes('\n');
}

/** 工具执行结果 → 回填给模型的文本。 */
export function formatToolResult(result: ToolResult, toolName: string): string {
  if (!result.ok) {
    return formatToolFailure(toolName, result.error);
  }
  const raw = JSON.stringify(result.data);
  // 全局密钥遮蔽：匹配 sk- 开头长字符串 → sk-****
  const text = maskSecrets(raw);
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…（结果已截断，共 ${text.length} 字符）`;
  }
  return text;
}
