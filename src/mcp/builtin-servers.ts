/**
 * 内置 MCP 服务预配置。
 *
 * 提供常用 MCP 服务的推荐配置，用户可在 ~/.concertoai/config.json 中引用或自定义。
 * 各服务以 npx 启动，需用户预先安装对应 npm 包。
 */

import type { MCPServerEntry } from '../store/config';
import type { MCPServerConfig } from './types';

/** 将用户配置条目转为 MCP 客户端连接配置。 */
export function toMcpServerConfig(entry: MCPServerEntry): MCPServerConfig {
  return {
    name: entry.name,
    command: entry.command,
    args: entry.args,
    env: entry.env,
  };
}

// ── 推荐预配置（供文档引用，非自动启用）──

/** filesystem MCP 服务：允许访问指定目录。 */
export const FILESYSTEM_SERVER: MCPServerEntry = {
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
};

/** memory MCP 服务：跨会话知识图谱。 */
export const MEMORY_SERVER: MCPServerEntry = {
  name: 'memory',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory'],
};

/** GitHub MCP 服务：仓库操作。 */
export const GITHUB_SERVER: MCPServerEntry = {
  name: 'github',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: {
    GITHUB_PERSONAL_ACCESS_TOKEN: '<your-token>',
  },
};
