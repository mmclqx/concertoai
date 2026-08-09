/**
 * 知识图谱类型定义（v2.1 M4）。
 *
 * 三层模型：Entity（实体） → Relation（关系） → Observation（观察）。
 * 与 MCP memory 工具签名保持一致，降低用户学习成本。
 */

/** 知识图谱实体。 */
export interface KnowledgeEntity {
  /** 实体名称（唯一标识）。 */
  name: string;
  /** 实体类型（如 "file", "module", "concept", "person"）。 */
  entityType: string;
  /** 观察列表（关于该实体的事实/知识点）。 */
  observations: string[];
  /** 最后访问时间戳（用于 LRU 淘汰）。 */
  lastAccessedAt: number;
}

/** 知识图谱关系（有向边）。 */
export interface KnowledgeRelation {
  /** 源实体名。 */
  from: string;
  /** 目标实体名。 */
  to: string;
  /** 关系类型（如 "depends_on", "implements", "contains"）。 */
  relationType: string;
}

/** 知识图谱观察（用于批量添加/删除操作的输入）。 */
export interface KnowledgeObservation {
  /** 所属实体名。 */
  entityName: string;
  /** 观察内容列表。 */
  contents: string[];
}

/** 知识图谱检索结果。 */
export interface KnowledgeSearchResult {
  /** 匹配到的实体。 */
  entity: KnowledgeEntity;
  /** 与该实体相关的关系列表。 */
  relations: KnowledgeRelation[];
  /** 匹配分数（关键词命中次数）。 */
  score: number;
}

/** 知识图谱删除观察的输入。 */
export interface KnowledgeObservationDeletion {
  /** 所属实体名。 */
  entityName: string;
  /** 要删除的观察内容列表。 */
  observations: string[];
}

/** 知识图谱删除关系的输入。 */
export interface KnowledgeRelationDeletion {
  /** 源实体名。 */
  from: string;
  /** 目标实体名。 */
  to: string;
  /** 关系类型。 */
  relationType: string;
}

/** 知识图谱完整导出。 */
export interface KnowledgeGraph {
  entities: KnowledgeEntity[];
  relations: KnowledgeRelation[];
}

/** TF-IDF 关键词权重（降级方案）。 */
export interface TfIdfWeights {
  /** term → weight 映射。 */
  weights: Map<string, number>;
  /** 文档总数（用于 IDF 计算）。 */
  documentCount: number;
}
