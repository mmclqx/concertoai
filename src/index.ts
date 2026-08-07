/**
 * Lumen 库入口（barrel）：导出 v0.1 全部公共 API。
 */

export const VERSION = '0.1.0';

export type { ZhDict } from './i18n/zh';
export { fmt, zh } from './i18n/zh';
export type { LoopEvent, LoopOptions } from './loop/loop';
export { MAX_LOOP_TURNS, runLoop } from './loop/loop';
export {
  assistantMessage,
  formatToolResult,
  MAX_TOOL_RESULT_CHARS,
  systemMessage,
  toApiMessages,
  toolResultMessage,
  userMessage,
} from './loop/messages';
export type { ChatMessage, Role, ToolCall } from './loop/types';
export type {
  ApiMessage,
  ApiToolCall,
  ChatCompletionChunk,
  DeepSeekClientOptions,
  ModelClient,
  StreamChatParams,
} from './model/client';
export {
  ApiError,
  DEEPSEEK_BASE_URL,
  DeepSeekClient,
  readSseEvents,
  TimeoutError,
} from './model/client';
export type { ModelProfile } from './model/models';
export { costFor, getDefaultModel, getModel, listModels, MODEL_PROFILES } from './model/models';
export { estimateMessageListTokens, estimateTokens } from './model/tokenizer';
export type { ProjectRules } from './store/project-rules';
export { loadProjectRules, MAX_RULES_CHARS, RULE_FILENAMES } from './store/project-rules';
export type { SessionSummary } from './store/session';

export { DEFAULT_SESSION_DIR, SessionStore } from './store/session';
export { editFileTool, planEdit } from './tools/edit';
export {
  listDirectoryTool,
  MAX_READ_CHARS,
  MAX_SEARCH_RESULTS,
  readFileTool,
  resolveSafe,
  searchContentTool,
} from './tools/read';
export type { ApprovalRequest, ToolContext, ToolResult, ToolSpec } from './tools/registry';
export { requestApproval, ToolRegistry } from './tools/registry';
export { DEFAULT_SHELL_TIMEOUT_MS, isAllowlisted, shellTool } from './tools/shell';
