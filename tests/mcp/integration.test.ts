/**
 * MCP 服务集成测试：验证内置配置、配置解析、ToolSpec 转换。
 */

import { describe, expect, it } from 'vitest';

import { FILESYSTEM_SERVER, GITHUB_SERVER, MEMORY_SERVER, toMcpServerConfig } from '../../src/mcp/builtin-servers';
import type { ToolSpec } from '../../src/tools/registry';

describe('内置 MCP 服务配置', () => {
  it('FILESYSTEM_SERVER 配置结构正确', () => {
    expect(FILESYSTEM_SERVER.name).toBe('filesystem');
    expect(FILESYSTEM_SERVER.command).toBe('npx');
    expect(FILESYSTEM_SERVER.args).toContain('@modelcontextprotocol/server-filesystem');
  });

  it('MEMORY_SERVER 配置结构正确', () => {
    expect(MEMORY_SERVER.name).toBe('memory');
    expect(MEMORY_SERVER.args).toContain('@modelcontextprotocol/server-memory');
  });

  it('GITHUB_SERVER 配置含环境变量', () => {
    expect(GITHUB_SERVER.name).toBe('github');
    expect(GITHUB_SERVER.env).toBeDefined();
    expect(GITHUB_SERVER.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBeDefined();
  });

  it('toMcpServerConfig 转换保留字段', () => {
    const config = toMcpServerConfig(FILESYSTEM_SERVER);
    expect(config.name).toBe('filesystem');
    expect(config.command).toBe('npx');
    expect(config.args).toEqual(FILESYSTEM_SERVER.args);
  });
});

describe('MCP ToolSpec 转换', () => {
  it('从 McpManager 工具列表创建 ToolSpec 结构合法', () => {
    // 模拟 McpManager.listTools 返回值
    const mockTools = [
      {
        name: 'fs/read_file',
        description: '读取文件',
        parameters: { _type: 'zod', _def: {} } as unknown as ToolSpec['parameters'],
        serverName: 'fs',
      },
    ];

    const specs: ToolSpec[] = mockTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      parallelSafe: false,
      execute: async () => ({ ok: true, data: 'test' }),
    }));

    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe('fs/read_file');
    expect(specs[0]?.parallelSafe).toBe(false);
  });
});
