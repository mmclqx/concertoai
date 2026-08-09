/**
 * 子代理类型定义（v2.0）。
 *
 * 子代理在主循环内隔离执行探索/研究类任务，只回传结论，不污染主上下文。
 * 通信基于函数调用（非 HTTP/stdio），输入为结构化 task 对象，输出为结构化 result 对象。
 */

// ── 子代理定义 ──────────────────────────────────────────────────

/** 子代理的可调用工具白名单（仅限内置只读工具名）。 */
export type SubagentToolName = 'read_file' | 'search_content' | 'list_directory';

/** 子代理定义：注册在 SubagentSpawner 上的子代理元数据。 */
export interface SubagentDef {
  /** 子代理标识名（spawn 时按此查找）。 */
  name: string;
  /** 用途说明（给调用方/模型参考）。 */
  description: string;
  /** 允许使用的工具名白名单（仅内置只读工具）。 */
  allowedTools: SubagentToolName[];
  /** 最大工具调用轮数（默认 5）。 */
  maxTurns: number;
  /** 超时（毫秒，默认 30_000）。 */
  timeoutMs: number;
  /** 子代理专用 system prompt（传入子代理的 system 消息）。 */
  systemPrompt: string;
  /** 最大可修复失败次数（默认与主循环 MAX_REPAIRS=2 一致；探索类子代理可设更高值容忍试错）。 */
  maxRepairs?: number;
  /**
   * 允许加载的 MCP 服务名列表（v2.1 M1）。
   * 不声明或空数组 = 不加载任何 MCP 工具（默认，安全优先）。
   * 声明的服务需在 McpManager 中已连接；未连接的服务跳过不阻塞。
   */
  allowedMcpServers?: string[];
  /**
   * v2.1 M5：知识库文件路径列表（相对于 skills/reviewer/knowledge/）。
   * Reviewer Agent 专用字段，用于注入审查标准和最佳实践。
   */
  knowledgeBase?: string[];
}

// ── 子代理任务 ──────────────────────────────────────────────────

/** 子代理任务输入：描述一次 spawn 调用的参数。 */
export interface SubagentTask {
  /** 要调用的子代理名称（必须已在 spawner 注册）。 */
  agentName: string;
  /** 任务描述（自然语言，供子代理模型理解）。 */
  prompt: string;
  /** 可选附加上下文（文件路径/代码片段等，注入子代理 system prompt）。 */
  context?: string;
}

// ── 子代理结果 ──────────────────────────────────────────────────

/** 子代理执行结果：spawn 调用的返回值。 */
export interface SubagentResult {
  /** 执行是否成功（ok = true 表示子代理正常完成并返回结论）。 */
  ok: boolean;
  /** 结论文本（ok 时包含子代理的最终回答；失败时为错误描述）。 */
  summary: string;
  /** 失败原因（ok = false 时填充）。 */
  error?: string;
  /** 子代理实际工具调用次数。 */
  toolCallCount: number;
  /** 执行耗时（毫秒）。 */
  durationMs: number;
}
