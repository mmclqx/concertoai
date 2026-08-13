/**
 * LSP 协议类型与常量（v4.0 M6 / T6.1，`concertoai lsp --stdio`）。
 *
 * 实现 Language Server Protocol 3.17 的最小闭环子集：
 * - JSON-RPC 2.0 消息类型（Request / Notification / Response）；
 * - LSP 方法名常量（initialize / didOpen / didSave / codeAction / publishDiagnostics）；
 * - LSP 数据结构（Diagnostic / CodeAction / WorkspaceEdit / TextEdit / Range / Position）。
 *
 * 仅覆盖「保存即诊断 + CodeAction 一键修复」所需协议面，不引入完整 LSP SDK
 * （保持零运行时依赖；需要更多方法时按同构扩展）。
 */

// ── JSON-RPC 2.0 ─────────────────────────────────────────────

/** JSON-RPC 消息基类。 */
export interface JsonRpcMessage {
  jsonrpc: '2.0';
}

/** 请求（带 id，需响应）。 */
export interface RequestMessage extends JsonRpcMessage {
  id: number | string;
  method: string;
  params?: unknown;
}

/** 通知（无 id，无需响应）。 */
export interface NotificationMessage extends JsonRpcMessage {
  method: string;
  params?: unknown;
}

/** 响应错误。 */
export interface ResponseError {
  code: number;
  message: string;
  data?: unknown;
}

/** 响应（成功 result 或错误 error，二选一）。 */
export interface ResponseMessage extends JsonRpcMessage {
  id: number | string;
  result?: unknown;
  error?: ResponseError;
}

/** 判别联合：输入消息 = 请求 | 通知。 */
export type IncomingMessage = RequestMessage | NotificationMessage;

/** JSON-RPC 标准错误码。 */
export const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ── LSP 方法名 ───────────────────────────────────────────────

/** LSP 方法名常量（最小闭环子集）。 */
export const LSP_METHOD = {
  initialize: 'initialize',
  initialized: 'initialized',
  shutdown: 'shutdown',
  exit: 'exit',
  didOpen: 'textDocument/didOpen',
  didChange: 'textDocument/didChange',
  didSave: 'textDocument/didSave',
  publishDiagnostics: 'textDocument/publishDiagnostics',
  codeAction: 'textDocument/codeAction',
} as const;

// ── LSP 基础类型 ─────────────────────────────────────────────

/** 位置（0-based，与 LSP 规范一致；文件行号显示时 +1）。 */
export interface LspPosition {
  line: number;
  character: number;
}

/** 区间。 */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** 文档标识。 */
export interface TextDocumentIdentifier {
  uri: string;
}

/** 文档内容（didOpen/didChange 事件）。 */
export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

/** 诊断严重性（LSP 规范：1 Error / 2 Warning / 3 Information / 4 Hint）。 */
export enum LspSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

/** 诊断。 */
export interface LspDiagnostic {
  range: LspRange;
  /** 严重性（缺省 = 1 Error）。 */
  severity?: LspSeverity;
  /** 诊断码（如 lint/suspicious/noExplicitAny / TS2304 / self-heal/unused-import）。 */
  code?: string;
  /** 诊断来源（concertoai-lint / concertoai-type / concertoai-selfheal）。 */
  source: string;
  /** 诊断消息（中文，供 Problems 面板展示）。 */
  message: string;
}

/** 诊断推送参数（publishDiagnostics 通知）。 */
export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
  /** 文档版本（可选）。 */
  version?: number;
}

/** 文本编辑（WorkspaceEdit 的最小单元）。 */
export interface TextEdit {
  range: LspRange;
  newText: string;
}

/** 工作区编辑（本版仅支持单文件 changes；多文件 documentChanges 延后）。 */
export interface WorkspaceEdit {
  /** URI → 文本编辑列表。 */
  changes?: Record<string, TextEdit[]>;
}

/** CodeAction kind 常量（LSP 3.17 quickfix）。 */
export const CODE_ACTION_KIND = {
  quickfix: 'quickfix',
} as const;

/** CodeAction（一键修复入口，T6.2）。 */
export interface CodeAction {
  /** 展示标题（「🔧 用 ConcertoAI 修复」/「移除未使用的 import」）。 */
  title: string;
  /** 修复类型（quickfix / refactor / source）。 */
  kind?: string;
  /** 关联的诊断（点击修复后这些诊断应消失）。 */
  diagnostics?: LspDiagnostic[];
  /** 修复编辑（应用后触发重新诊断 → 已修复诊断消失）。 */
  edit?: WorkspaceEdit;
}

/** codeAction 请求参数。 */
export interface CodeActionParams {
  textDocument: TextDocumentIdentifier;
  range: LspRange;
  context: { diagnostics: LspDiagnostic[] };
}

// ── initialize 能力声明 ──────────────────────────────────────

/** 初始化结果（声明服务端能力：文本同步 + CodeAction 提供）。 */
export interface InitializeResult {
  capabilities: {
    /** 文本同步：1 = full（didChange 传全文）。 */
    textDocumentSync: number;
    /** CodeAction 提供。 */
    codeActionProvider: boolean;
  };
  serverInfo?: { name: string; version: string };
}

/** 诊断来源常量（source 字段，供客户端区分三来源）。 */
export const DIAGNOSTIC_SOURCE = {
  lint: 'concertoai-lint',
  type: 'concertoai-type',
  selfHeal: 'concertoai-selfheal',
} as const;

/** 诊断严重性中文标签（展示/测试断言用）。 */
export const SEVERITY_LABEL: Record<LspSeverity, string> = {
  [LspSeverity.Error]: 'Error',
  [LspSeverity.Warning]: 'Warning',
  [LspSeverity.Information]: 'Information',
  [LspSeverity.Hint]: 'Hint',
};
