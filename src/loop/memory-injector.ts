/**
 * MCP Memory 检索与上下文注入器。
 *
 * 每轮对话前，从 memory MCP 服务检索与用户输入相关的记忆，
 * 格式化为 `# 记忆` 块注入系统提示开头。
 *
 * 设计要点：
 * - 依赖 McpManager 中的 memory 命名服务（用户配置时指定 name: "memory"）；
 * - 检索失败/超时时静默降级（不阻塞对话）；
 * - 检索结果上限可控（默认 5 条），避免上下文膨胀。
 */

import type { McpManager } from '../mcp/manager';

/** 记忆检索结果。 */
export interface MemoryEntry {
  title: string;
  content: string;
  score?: number;
}

/** 注入器配置。 */
export interface MemoryInjectorOptions {
  /** memory MCP 服务的名称（对应配置中的 name 字段）。默认 'memory'。 */
  serverName?: string;
  /** 注入上下文的最大记忆条数。默认 5。 */
  maxEntries?: number;
}

/**
 * 从 memory MCP 服务检索相关记忆，格式化为注入文本。
 * 检索失败返回空字符串（静默降级）。
 */
export class MemoryInjector {
  private readonly serverName: string;
  private readonly maxEntries: number;

  constructor(
    private readonly mcpManager: McpManager,
    options: MemoryInjectorOptions = {},
  ) {
    this.serverName = options.serverName ?? 'memory';
    this.maxEntries = options.maxEntries ?? 5;
  }

  /**
   * 根据用户查询检索相关记忆，返回格式化的注入文本。
   * 无匹配 / 服务不可用时返回空字符串。
   */
  async retrieve(query: string): Promise<string> {
    const client = this.mcpManager.getClient(this.serverName);
    if (client === undefined || !client.connected) {
      return '';
    }

    try {
      const result = await client.callTool({
        name: 'search_nodes',
        arguments: { query, limit: this.maxEntries },
      });

      if (result.isError) {
        return '';
      }

      const entries = this.parseEntries(result);
      if (entries.length === 0) {
        return '';
      }

      return this.formatInjectBlock(entries);
    } catch {
      // 检索失败静默降级
      return '';
    }
  }

  /** 手动写入一条记忆（模型触发，经用户审批后调用）。 */
  async store(title: string, content: string, tags?: string[]): Promise<boolean> {
    const client = this.mcpManager.getClient(this.serverName);
    if (client === undefined || !client.connected) {
      return false;
    }
    try {
      const result = await client.callTool({
        name: 'create_entities',
        arguments: {
          entities: [
            {
              name: title,
              entityType: 'memory',
              observations: [content, ...(tags ?? [])],
            },
          ],
        },
      });
      return !result.isError;
    } catch {
      return false;
    }
  }

  /** 从 CallToolResult 中解析记忆条目列表。 */
  private parseEntries(result: { content: Array<{ type: string; text?: string }> }): MemoryEntry[] {
    const text = result.content
      .filter((b): b is typeof b & { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (text === '') {
      return [];
    }

    try {
      // memory MCP 的 search_nodes 返回 JSON 结构
      const parsed = JSON.parse(text) as {
        results?: Array<{ name?: string; observations?: string[]; score?: number }>;
      };
      return (parsed.results ?? []).map((r) => ({
        title: r.name ?? '(未命名)',
        content: (r.observations ?? []).join('; '),
        score: r.score,
      }));
    } catch {
      // 非 JSON 格式 → 作为纯文本返回单条
      return [{ title: '相关记忆', content: text }];
    }
  }

  /** 格式化为系统提示注入块。 */
  private formatInjectBlock(entries: MemoryEntry[]): string {
    const lines = entries.map((e, i) => `${i + 1}. ${e.title}: ${e.content.slice(0, 300)}`);
    return `# 相关记忆\n${lines.join('\n')}`;
  }
}
