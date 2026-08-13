/**
 * LSP 模块 barrel（v4.0 M6）。
 */

export {
  applyTextEdits,
  biomeFixEdits,
  ChildProcessDiagnosticRunner,
  consoleLogDiagnostics,
  type DiagnosticRunner,
  explicitAnyDiagnostics,
  extractNamedImports,
  type FileDiagnostics,
  fullFileReplacementEdit,
  type NamedImport,
  parseBiomeLintOutput,
  parseTscOutput,
  pathToUri,
  selfHealCodeActions,
  selfHealStaticDiagnostics,
  sortDiagnostics,
  unusedImportDiagnostics,
  uriToPath,
} from './diagnostics';
export { encodeMessage, FrameReader } from './framing';
export {
  type CodeAction,
  type CodeActionParams,
  DIAGNOSTIC_SOURCE,
  type IncomingMessage,
  type InitializeResult,
  JSONRPC_ERROR,
  type JsonRpcMessage,
  LSP_METHOD,
  type LspDiagnostic,
  type LspPosition,
  type LspRange,
  LspSeverity,
  type NotificationMessage,
  type PublishDiagnosticsParams,
  type RequestMessage,
  type ResponseError,
  type ResponseMessage,
  SEVERITY_LABEL,
  type TextDocumentIdentifier,
  type TextDocumentItem,
  type TextEdit,
  type WorkspaceEdit,
} from './protocol';
export { LspServer, type LspServerOptions } from './server';
