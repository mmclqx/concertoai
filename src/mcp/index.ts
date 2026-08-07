export { McpClient, McpClientError } from './client';
export { McpManager } from './manager';
export type { AggregatedTool, MCPServerStatus } from './manager';
export {
  FILESYSTEM_SERVER,
  GITHUB_SERVER,
  MEMORY_SERVER,
  toMcpServerConfig,
} from './builtin-servers';
export type {
  MCPServerConfig,
  MCPToolDef,
  CallToolParams,
  CallToolResult,
  ToolContentBlock,
  ListToolsResult,
} from './types';
