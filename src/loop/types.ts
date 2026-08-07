/**
 * 会话层消息类型（区别于 client.ts 的 ApiMessage：后者是与 API 线格式对齐的形态）。
 * ToolSpec 定义见 tools/registry.ts。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** 工具参数的 JSON 字符串（模型返回的原始形态，调用时解析）。 */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  /** role === 'tool' 时，关联的 assistant tool_calls id。 */
  toolCallId?: string;
  /** role === 'assistant' 且发起工具调用时存在。 */
  toolCalls?: ToolCall[];
}
