/**
 * MCP 服务管理器：多 MCP 服务的生命周期管理、工具聚合与路由。
 *
 * 设计要点：
 * - 启动时并发连接所有已配置的 MCP 服务；
 * - 各服务工具以 `serverName/` 前缀命名，避免跨服务工具名冲突；
 * - 工具聚合为统一的 ToolSpec 列表，可直接注册到 ToolRegistry；
 * - 单服务故障不影响其他服务（降级而非崩溃）；
 * - 工具调用路由：按前缀解析 → 转发到对应客户端。
 */

import { z } from 'zod';

import type { ToolResult } from '../tools/registry';
import { McpClient } from './client';
import type { CallToolParams, MCPToolDef, MCPServerConfig } from './types';
import { toZodSchema } from './zod-adapter';

// ── 聚合工具元数据 ──

export interface AggregatedTool {
  /** 原始 MCP 工具定义。 */
  def: MCPToolDef;
  /** 归属的 MCP 服务名。 */
  serverName: string;
  /** 带前缀的聚合工具名（格式: serverName/toolName）。 */
  prefixedName: string;
}

/** 连接状态。 */
export interface MCPServerStatus {
  name: string;
  command: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

// ── 管理器实现 ──

export class McpManager {
  private clients = new Map<string, McpClient>();
  private tools = new Map<string, AggregatedTool>();

  /**
   * @param configs 各 MCP 服务的连接配置。
   */
  constructor(private readonly configs: MCPServerConfig[]) {}

  /** 并发连接所有配置的 MCP 服务。单服务失败不阻塞其他服务。 */
  async start(): Promise<MCPServerStatus[]> {
    const results = await Promise.allSettled(
      this.configs.map(async (config) => {
        const client = new McpClient(config);
        await client.connect();
        const tools = await client.listTools();
        this.clients.set(config.name, client);
        // 以 serverName/ 前缀注册工具
        for (const def of tools) {
          const prefixedName = `${config.name}/${def.name}`;
          this.tools.set(prefixedName, { def, serverName: config.name, prefixedName });
        }
        return {
          name: config.name,
          command: config.command,
          connected: true,
          toolCount: tools.length,
        };
      }),
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') {
        return r.value;
      }
      return {
        name: this.configs[i]?.name ?? 'unknown',
        command: this.configs[i]?.command ?? '',
        connected: false,
        toolCount: 0,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });
  }

  /** 断开所有 MCP 服务连接。 */
  disconnect(): void {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
    this.tools.clear();
  }

  /** 获取所有聚合后的工具列表（ToolSpec 兼容格式，可直接注册到 ToolRegistry）。 */
  listTools(): Array<{
    name: string;
    description: string;
    parameters: z.ZodTypeAny;
    serverName: string;
  }> {
    return [...this.tools.values()].map((t) => ({
      name: t.prefixedName,
      description: t.def.description ?? `${t.serverName}/${t.def.name}`,
      parameters: toZodSchema(t.def.inputSchema),
      serverName: t.serverName,
    }));
  }

  /** 调用聚合工具（按前缀路由到对应客户端）。 */
  async callTool(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { ok: false, error: `未知 MCP 工具: ${name}`, repairable: false };
    }
    const client = this.clients.get(tool.serverName);
    if (client === undefined) {
      return { ok: false, error: `MCP 服务未连接: ${tool.serverName}`, repairable: false };
    }
    try {
      const params: CallToolParams = {
        name: tool.def.name,
        arguments: args as Record<string, unknown> | undefined,
      };
      const result = await client.callTool(params);
      // 提取文本内容块拼接为字符串回填
      const text = result.content
        .filter((block): block is typeof block & { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const isError = result.isError === true;
      return isError
        ? { ok: false, error: text || 'MCP 工具返回错误', repairable: true }
        : { ok: true, data: text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, repairable: true };
    }
  }

  /** 按服务名查找客户端（用于检查连接状态）。 */
  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  /** 获取所有服务的连接状态快照。 */
  status(): MCPServerStatus[] {
    return [...this.clients.values()].map((client) => {
      const serverTools = [...this.tools.values()].filter(
        (t) => t.serverName === client.serverName,
      );
      return {
        name: client.serverName,
        command: this.configs.find((c) => c.name === client.serverName)?.command ?? '',
        connected: client.connected,
        toolCount: serverTools.length,
      };
    });
  }
}
