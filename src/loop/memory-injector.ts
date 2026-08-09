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

import type { KnowledgeStore } from '../knowledge/store';
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
 * 单次 MCP 记忆检索的最大等待时间（毫秒）。
 * v2.1 性能优化：检索超时静默降级（返回空），避免慢服务拖住首字节延迟。
 */
const MEMORY_RETRIEVE_TIMEOUT_MS = 400;

/**
 * 双源记忆注入器：MCP memory + 本地知识图谱。
 * 检索结果合并去重后注入 system prompt。
 */
export class MemoryInjector {
  private readonly serverName: string;
  private readonly maxEntries: number;
  private readonly knowledgeStore: KnowledgeStore | undefined;

  constructor(
    private readonly mcpManager: McpManager,
    options: MemoryInjectorOptions = {},
    knowledgeStore?: KnowledgeStore,
  ) {
    this.serverName = options.serverName ?? 'memory';
    this.maxEntries = options.maxEntries ?? 5;
    this.knowledgeStore = knowledgeStore;
  }

  /**
   * 双源检索：MCP memory + 本地知识图谱，合并去重后返回格式化文本。
   * 无匹配 / 服务不可用时返回空字符串。
   */
  async retrieve(query: string): Promise<string> {
    const entries: MemoryEntry[] = [];

    // 源 1：MCP memory（带超时：慢服务不拖住首字节，超时静默降级）
    const client = this.mcpManager.getClient(this.serverName);
    if (client?.connected) {
      try {
        const result = await withTimeout(
          client.callTool({
            name: 'search_nodes',
            arguments: { query, limit: this.maxEntries },
          }),
          MEMORY_RETRIEVE_TIMEOUT_MS,
        );
        if (result !== null && !result.isError) {
          entries.push(...this.parseEntries(result));
        }
      } catch {
        // MCP 检索失败/超时静默降级
      }
    }

    // 源 2：本地知识图谱（v2.1 M4）
    if (this.knowledgeStore !== undefined) {
      try {
        const kgResults = this.knowledgeStore.search(query);
        for (const r of kgResults.slice(0, this.maxEntries)) {
          // 按 (entityName, observation) 去重
          for (const obs of r.entity.observations) {
            const dup = entries.some((e) => e.title === r.entity.name && e.content === obs);
            if (!dup) {
              entries.push({ title: r.entity.name, content: obs, score: r.score });
            }
          }
        }
      } catch {
        // 本地图谱检索失败静默降级
      }
    }

    if (entries.length === 0) {
      return '';
    }

    // 截断总 token 数 ~2000
    return this.formatInjectBlock(entries.slice(0, this.maxEntries * 2));
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

/**
 * Promise.race 超时包装：超时返回 null（不抛错），由调用方静默降级。
 * 未完成的原始 promise 由 MCP 客户端内部 30s 超时兜底回收，不产生泄漏。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
