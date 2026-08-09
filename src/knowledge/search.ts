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
   */
  search(query: string, limit = 20): KnowledgeSearchResult[] {
    const results = this.store.search(query);
    // 考虑关系关联度加分：被多处引用的实体加权
    const graph = this.store.readGraph();
    const relationCounts = new Map<string, number>();
    for (const rel of graph.relations) {
      relationCounts.set(rel.from, (relationCounts.get(rel.from) ?? 0) + 1);
      relationCounts.set(rel.to, (relationCounts.get(rel.to) ?? 0) + 1);
    }
    for (const r of results) {
      const rc = relationCounts.get(r.entity.name) ?? 0;
      r.score += rc * 0.5; // 每个关联关系加 0.5 分
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
