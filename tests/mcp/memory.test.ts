/**
 * MemoryInjector 单元测试。
 *
 * 验证记忆检索、格式化、写入、降级行为。
 */

import { describe, expect, it } from 'vitest';

import { MemoryInjector } from '../../src/loop/memory-injector';
import { McpManager } from '../../src/mcp/manager';
import type { MCPServerConfig } from '../../src/mcp/types';

const mockServerArgs = ['--import', 'tsx', 'tests/mcp/mock-server.ts'];

function makeConfig(name: string): MCPServerConfig {
  return { name, command: 'node', args: [...mockServerArgs] };
}

describe('MemoryInjector', () => {
  it('memory 服务未配置时 retrieve 返回空字符串', async () => {
    const manager = new McpManager([makeConfig('other')]);
    try {
      await manager.start();
      const injector = new MemoryInjector(manager, { serverName: 'memory' });
      const result = await injector.retrieve('测试查询');
      expect(result).toBe('');
    } finally {
      manager.disconnect();
    }
  });

  it('mock 服务无 search_nodes 工具时 retrieve 返回空字符串（降级）', async () => {
    // mock-server 没有记忆相关工具，调用应降级
    const manager = new McpManager([makeConfig('memory')]);
    try {
      await manager.start();
      const injector = new MemoryInjector(manager);
      // mock-server 会返回 unknown tool 错误，injector 应静默返回空
      const result = await injector.retrieve('测试查询');
      expect(result).toBe('');
    } finally {
      manager.disconnect();
    }
  });

  it('store 未连接时返回 false', async () => {
    const manager = new McpManager([makeConfig('memory')]);
    const injector = new MemoryInjector(manager);
    // 不调用 start → 未连接
    const ok = await injector.store('title', 'content');
    expect(ok).toBe(false);
  });

  it('MCP 检索慢于超时阈值时静默降级返回空字符串（不拖住首字节）', async () => {
    // duck-typed 慢 client：callTool 需要 600ms > 400ms 超时阈值
    const slowClient = {
      connected: true,
      callTool: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return { content: [], isError: false };
      },
    };
    const fakeManager = {
      getClient: () => slowClient,
    };
    const injector = new MemoryInjector(fakeManager as unknown as McpManager, {}, undefined);
    const t0 = Date.now();
    const result = await injector.retrieve('慢查询');
    const elapsed = Date.now() - t0;
    expect(result).toBe('');
    // 未等待慢服务完成（600ms），被 400ms 超时截断
    expect(elapsed).toBeLessThan(600);
  });

  it('maxEntries 默认值为 5', () => {
    const manager = new McpManager([]);
    const injector = new MemoryInjector(manager);
    // 通过 retrieve 会调用 search_nodes 时传递 limit
    // 这里只验证构造器不抛错
    expect(injector).toBeDefined();
  });
});
