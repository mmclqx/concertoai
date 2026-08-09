/**
 * McpManager 单元测试。
 *
 * 验证多服务管理、工具聚合与路由、故障隔离。
 */

import { describe, expect, it } from 'vitest';

import { McpManager } from '../../src/mcp/manager';
import type { MCPServerConfig } from '../../src/mcp/types';

const mockServerArgs = ['--import', 'tsx', 'tests/mcp/mock-server.ts'];

function makeConfig(name: string, extraArgs?: string[]): MCPServerConfig {
  return {
    name,
    command: 'node',
    args: [...mockServerArgs, ...(extraArgs ?? [])],
  };
}

describe('McpManager 启动', () => {
  it('单个服务启动成功，工具带前缀', async () => {
    const manager = new McpManager([makeConfig('srv1')]);
    try {
      const status = await manager.start();
      expect(status).toHaveLength(1);
      expect(status[0]?.connected).toBe(true);
      expect(status[0]?.toolCount).toBeGreaterThanOrEqual(3);

      const tools = manager.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(3);
      // 工具名带 serverName_ 前缀
      for (const tool of tools) {
        expect(tool.name).toMatch(/^srv1_/);
      }
    } finally {
      manager.disconnect();
    }
  });

  it('多个服务启动，工具聚合后各有独立前缀', async () => {
    const manager = new McpManager([makeConfig('fs'), makeConfig('mem')]);
    try {
      const status = await manager.start();
      expect(status).toHaveLength(2);
      expect(status.every((s) => s.connected)).toBe(true);

      const tools = manager.listTools();
      const fsTools = tools.filter((t) => t.name.startsWith('fs_'));
      const memTools = tools.filter((t) => t.name.startsWith('mem_'));
      expect(fsTools.length).toBeGreaterThanOrEqual(3);
      expect(memTools.length).toBeGreaterThanOrEqual(3);
    } finally {
      manager.disconnect();
    }
  });

  it('无效服务启动失败，不影响其他服务', async () => {
    const manager = new McpManager([
      makeConfig('good'),
      { name: 'bad', command: 'no-such-command-xyz' },
    ]);
    try {
      const status = await manager.start();
      expect(status).toHaveLength(2);
      // 好的连上
      const good = status.find((s) => s.name === 'good');
      expect(good?.connected).toBe(true);
      // 坏的失败但不抛错
      const bad = status.find((s) => s.name === 'bad');
      expect(bad?.connected).toBe(false);
      expect(bad?.error).toBeTruthy();

      // 好的服务工具仍可用
      const tools = manager.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(3);
    } finally {
      manager.disconnect();
    }
  });
});

describe('McpManager 工具调用', () => {
  it('callTool 按前缀路由到对应服务', async () => {
    const manager = new McpManager([makeConfig('test')]);
    try {
      await manager.start();
      const result = await manager.callTool('test_echo', { message: 'hi' });
      expect(result.ok).toBe(true);
      expect(result.data).toBe('echo: hi');
    } finally {
      manager.disconnect();
    }
  });

  it('callTool 工具执行失败返回 ok:false', async () => {
    const manager = new McpManager([makeConfig('test')]);
    try {
      await manager.start();
      const result = await manager.callTool('test_fail', {});
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      manager.disconnect();
    }
  });

  it('callTool 未知工具返回 ok:false', async () => {
    const manager = new McpManager([makeConfig('test')]);
    try {
      await manager.start();
      const result = await manager.callTool('test_no-such-tool', {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain('未知');
    } finally {
      manager.disconnect();
    }
  });

  it('disconnect 后 callTool 返回错误但不崩溃', async () => {
    const manager = new McpManager([makeConfig('test')]);
    await manager.start();
    manager.disconnect();
    const result = await manager.callTool('test_echo', {});
    expect(result.ok).toBe(false);
  });
});

describe('McpManager 状态', () => {
  it('status 返回各服务连接状态', async () => {
    const manager = new McpManager([makeConfig('s1'), makeConfig('s2')]);
    try {
      await manager.start();
      const s = manager.status();
      expect(s).toHaveLength(2);
      for (const entry of s) {
        expect(entry.connected).toBe(true);
        expect(entry.toolCount).toBeGreaterThanOrEqual(3);
      }
    } finally {
      manager.disconnect();
    }
  });
});
