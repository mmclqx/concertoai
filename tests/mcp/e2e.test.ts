/**
 * MCP 全链路端到端测试。
 *
 * 覆盖完整链路：mock 服务启动 → 连接 → 工具发现 → 工具调用 → 结果回填。
 * 使用 tests/mcp/mock-server.ts 作为 mock MCP 服务。
 */

import { describe, expect, it } from 'vitest';

import { McpManager } from '../../src/mcp/manager';
import type { MCPServerConfig } from '../../src/mcp/types';
import type { ToolSpec } from '../../src/tools/registry';

const mockServerArgs = ['--import', 'tsx', 'tests/mcp/mock-server.ts'];

function makeConfig(name: string): MCPServerConfig {
  return { name, command: 'node', args: [...mockServerArgs] };
}

describe('MCP 全链路 E2E', () => {
  it('mock 服务完整链路：连接 → 发现 → 调用 → 回填', async () => {
    const manager = new McpManager([makeConfig('e2e')]);
    try {
      // 1. 连接
      const status = await manager.start();
      expect(status).toHaveLength(1);
      expect(status[0]?.connected).toBe(true);
      expect(status[0]?.toolCount).toBeGreaterThanOrEqual(3);

      // 2. 工具发现 → 转为 ToolSpec
      const specs = manager.listTools();
      expect(specs.length).toBeGreaterThanOrEqual(3);
      for (const spec of specs) {
        expect(spec.name).toMatch(/^e2e_/);
        expect(spec.description).toBeTruthy();
      }

      // 3. 工具调用（echo）
      const echoResult = await manager.callTool('e2e_echo', { message: 'hello e2e' });
      expect(echoResult.ok).toBe(true);
      expect(echoResult.data).toBe('echo: hello e2e');

      // 4. 工具调用（fail → 错误回填）
      const failResult = await manager.callTool('e2e_fail', {});
      expect(failResult.ok).toBe(false);
      expect(failResult.error).toBeTruthy();

      // 5. 未知工具 → 错误
      const unknownResult = await manager.callTool('e2e_no-such-tool', {});
      expect(unknownResult.ok).toBe(false);
    } finally {
      manager.disconnect();
    }
  });

  it('多服务并发：两个 mock 服务同时连接并独立调用', async () => {
    const manager = new McpManager([makeConfig('srv-a'), makeConfig('srv-b')]);
    try {
      const status = await manager.start();
      expect(status).toHaveLength(2);
      expect(status.every((s) => s.connected)).toBe(true);

      // 各服务工具独立
      const allTools = manager.listTools();
      const aTools = allTools.filter((t) => t.name.startsWith('srv-a_'));
      const bTools = allTools.filter((t) => t.name.startsWith('srv-b_'));
      expect(aTools.length).toBeGreaterThanOrEqual(3);
      expect(bTools.length).toBeGreaterThanOrEqual(3);

      // 独立调用
      const aResult = await manager.callTool('srv-a_echo', { message: 'a' });
      const bResult = await manager.callTool('srv-b_echo', { message: 'b' });
      expect(aResult.ok).toBe(true);
      expect(bResult.ok).toBe(true);
    } finally {
      manager.disconnect();
    }
  });

  it('MCP 工具转为 ToolSpec 可注册到 ToolRegistry', async () => {
    const manager = new McpManager([makeConfig('reg')]);
    try {
      await manager.start();
      const raw = manager.listTools();

      const specs: ToolSpec[] = raw.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        parallelSafe: false,
        execute: async (args: unknown, _ctx: unknown) => manager.callTool(t.name, args),
      }));

      expect(specs.length).toBeGreaterThanOrEqual(3);

      // 模拟 ToolRegistry.run 行为
      for (const spec of specs) {
        if (spec.name.endsWith('_echo')) {
          const result = await spec.execute({ message: 'test' }, { cwd: process.cwd() });
          expect(result.ok).toBe(true);
        }
      }
    } finally {
      manager.disconnect();
    }
  });
});
