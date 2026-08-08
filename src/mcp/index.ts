export {
  FILESYSTEM_SERVER,
  GITHUB_SERVER,
  MEMORY_SERVER,
  toMcpServerConfig,
} from './builtin-servers';
export { McpClient, McpClientError } from './client';
export type { AggregatedTool, MCPServerStatus } from './manager';
export { McpManager } from './manager';
export type {
  CallToolParams,
  CallToolResult,
  ListToolsResult,
  MCPServerConfig,
  MCPToolDef,
  ToolContentBlock,
} from './types';
