/**
 * 知识图谱语义搜索（v2.1 M4）。
 *
 * TF-IDF 关键词匹配（零外部依赖）。
 * 未来可升级为 ONNX embedding 方案。
 */

import type { KnowledgeStore } from './store';
import type { KnowledgeSearchResult } from './types';

export class KnowledgeSearch {
  constructor(private readonly store: KnowledgeStore) {}

  /**
   * 搜索知识图谱。
   * 当前使用增强型关键词匹配（名称权重 > 类型权重 > 观察内容）。
   *
   * v2.1 性能优化：关联度加权直接复用 store.search 已通过邻接表返回的
   * relations（length = in-degree + out-degree = 实体的关系度数），
   * 不再 readGraph() 复制整个图谱再遍历全部关系（消除 O(V+E) 开销）。
   */
  search(query: string, limit = 20): KnowledgeSearchResult[] {
    const results = this.store.search(query);
    // 关联度加分：被多处引用的实体加权（每个关联关系加 0.5 分）
    for (const r of results) {
      r.score += r.relations.length * 0.5;
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
