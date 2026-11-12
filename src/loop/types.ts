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
  /**
   * v5.2 N2：仅当这次工具调用的审批被「低风险自动放行」时存在（`'auto-low'`）。
   *
   * ## 缺省的含义，以及一个已知的歧义
   *
   * 缺省 = **不是自动放行**。注意它同时也涵盖「这个工具根本不需要审批」
   * （`read_file` / `list_directory` 等从不申请审批），所以严格说缺省并不能
   * 区分这两种情况。
   *
   * **为什么接受这个歧义**：本版**刻意不记 `'user'`**。记了会让默认路径（用户按 y 批准）
   * 的每条 tool 消息都多一个字段 ⇒ 现有断言精确形状的用例大面积红，而 N2 要回答的
   * 问题恰好是「**是不是自动放的**」——缺省即可回答。取舍已知，写在这里不藏。
   *
   * ## 为什么记在消息上而不是写独立的会话事件行
   *
   * `SessionStore.read()` 把 JSONL **每一行原样**当作 `ChatMessage`（不校验 `role`）。
   * 写一条 `{ type: 'auto-approval', ... }` 会变成 `{ role: undefined }` 混进 messages，
   * 而 messages 正是 `toApiMessages` 的输入 ⇒ 直接污染 API 请求。详见 ADR-053。
   */
  approval?: 'auto-low';
}
