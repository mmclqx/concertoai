/**
 * 本地项目记忆检索与格式化。
 *
 * 从 MemoryStore 检索相关记忆，格式化为注入文本。
 * 与 MCP memory-injector（T1.3）互补：本模块处理本地 `.lumen-memory/`。
 */

import type { MemoryStore } from '../store/memory-store';

/**
 * 从本地记忆存储检索与用户查询相关的记忆条目，
 * 格式化为 `# 项目记忆` 块，供注入系统提示。
 * 无匹配返回空字符串。
 */
export async function retrieveLocalMemories(
  store: MemoryStore,
  query: string,
  maxEntries = 5,
): Promise<string> {
  try {
    const entries = await store.search(query, { limit: maxEntries });
    if (entries.length === 0) {
      return '';
    }
    const lines = entries.map(
      (e, i) => `${i + 1}. ${e.title}: ${e.content.slice(0, 300)}`,
    );
    return `# 项目记忆\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}
