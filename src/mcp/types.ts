/**
 * MCP（Model Context Protocol）类型定义。
 *
 * 基于 MCP 规范（2024-11-05 修订版）的 JSON-RPC 2.0 消息格式，
 * 覆盖客户端连接、工具发现、工具调用所需的最小类型集。
 */

// ── JSON-RPC 2.0 基础 ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── MCP 协议常量 ──

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_CLIENT_NAME = 'lumen';
export const MCP_CLIENT_VERSION = '1.1.0';

// ── initialize ──

export interface InitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
}

// ── tools/list ──

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface ListToolsResult {
  tools: MCPToolDef[];
}

// ── tools/call ──

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface CallToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
}

// ── MCP 服务配置 ──

/** 单个 MCP 服务的连接配置（stdio transport）。 */
export interface MCPServerConfig {
  /** 服务标识（用于日志与工具名前缀）。 */
  name: string;
  /** 启动命令。 */
  command: string;
  /** 命令参数。 */
  args?: string[];
  /** 环境变量（追加到当前进程）。 */
  env?: Record<string, string>;
}
