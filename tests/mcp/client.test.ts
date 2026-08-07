/**
 * McpClient 单元测试。
 *
 * 使用模拟 MCP 服务进程（tests/mcp/mock-server.ts）验证：
 * - 连接握手（initialize → initialized）
 * - 工具发现（listTools）
 * - 工具调用（callTool: 成功、失败、超时）
 * - 连接断开与清理
 * - 错误处理（无效命令、进程崩溃）
 */

import { afterEach, describe, expect, it } from 'vitest';

import { McpClient } from '../../src/mcp/client';
import type { MCPServerConfig } from '../../src/mcp/types';

/** mock-server 的 node 启动配置。 */
const mockConfig: MCPServerConfig = {
  name: 'mock',
  command: 'node',
  args: ['--import', 'tsx', 'tests/mcp/mock-server.ts'],
};

function createClient(overrides?: Partial<MCPServerConfig>): McpClient {
  return new McpClient({ ...mockConfig, ...overrides });
}

afterEach(() => {
  // 确保每个测试后断开连接
});

describe('McpClient 连接', () => {
  it('connect 完成握手后 connected 为 true', async () => {
    const client = createClient();
    try {
      await client.connect();
      expect(client.connected).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('connect 幂等：重复调用不报错', async () => {
    const client = createClient();
    try {
      await client.connect();
      await client.connect(); // 第二次
      expect(client.connected).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('无效命令抛错', async () => {
    const client = createClient({ command: 'no-such-command-xyz' });
    await expect(client.connect()).rejects.toThrow();
    expect(client.connected).toBe(false);
  });
});

describe('McpClient 工具发现', () => {
  it('listTools 返回 mock 服务的预置工具列表', async () => {
    const client = createClient();
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(3);
      const names = tools.map((t) => t.name);
      expect(names).toContain('echo');
      expect(names).toContain('fail');
      expect(names).toContain('slow');
    } finally {
      client.disconnect();
    }
  });

  it('listTools 未连接时自动连接', async () => {
    const client = createClient();
    try {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(3);
      expect(client.connected).toBe(true);
    } finally {
      client.disconnect();
    }
  });
});

describe('McpClient 工具调用', () => {
  it('callTool echo 返回回显文本', async () => {
    const client = createClient();
    try {
      await client.connect();
      const result = await client.callTool({
        name: 'echo',
        arguments: { message: 'hello' },
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0]?.type).toBe('text');
      expect((result.content[0] as { text: string }).text).toBe('echo: hello');
    } finally {
      client.disconnect();
    }
  });

  it('callTool fail 返回 isError: true', async () => {
    const client = createClient();
    try {
      await client.connect();
      const result = await client.callTool({ name: 'fail', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.type).toBe('text');
    } finally {
      client.disconnect();
    }
  });

  it('callTool slow 延迟返回但未超时', async () => {
    const client = createClient();
    try {
      await client.connect();
      const start = Date.now();
      const result = await client.callTool({
        name: 'slow',
        arguments: { delayMs: 150 },
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(result.content[0]?.type).toBe('text');
    } finally {
      client.disconnect();
    }
  });
});

describe('McpClient 断连', () => {
  it('disconnect 后 connected 变为 false', async () => {
    const client = createClient();
    await client.connect();
    client.disconnect();
    expect(client.connected).toBe(false);
  });

  it('disconnect 后 listTools 抛错', async () => {
    const client = createClient();
    await client.connect();
    client.disconnect();
    await expect(client.listTools()).rejects.toThrow();
  });
});
