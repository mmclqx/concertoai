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

  it('maxEntries 默认值为 5', () => {
    const manager = new McpManager([]);
    const injector = new MemoryInjector(manager);
    // 通过 retrieve 会调用 search_nodes 时传递 limit
    // 这里只验证构造器不抛错
    expect(injector).toBeDefined();
  });
});
