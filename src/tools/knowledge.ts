/**
 * 知识图谱工具集（v2.1 M4）。
 *
 * 5 个工具注册到 ToolRegistry，模型可在对话中调用。
 * 签名与 MCP memory 工具保持一致以降低学习成本。
 */

import { z } from 'zod';

import type { KnowledgeStore } from '../knowledge/store';
import { ToolErrorCode, toolError } from './error-codes';
import type { ToolResult, ToolSpec } from './registry';

// ── Schema 定义 ────────────────────────────────────────────

const entitySchema = z.object({
  name: z.string().min(1),
  entityType: z.string().min(1),
  observations: z.array(z.string()),
});

const relationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: z.string().min(1),
});

const observationDeletionSchema = z.object({
  entityName: z.string().min(1),
  observations: z.array(z.string()),
});

const relationDeletionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: z.string().min(1),
});

// ── 工具工厂 ───────────────────────────────────────────────

/** 创建 5 个知识图谱工具，共享同一个 KnowledgeStore 实例。 */
export function createKnowledgeTools(store: KnowledgeStore): ToolSpec[] {
  // 获取 store 引用（闭包捕获）
  const s = store;

  /** 包装执行：存储层异常统一归为 STORE_UNAVAILABLE（v3.1 M4）。 */
  const withStoreGuard = async (
    fn: () => ToolResult | Promise<ToolResult>,
  ): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (error) {
      return toolError(
        ToolErrorCode.STORE_UNAVAILABLE,
        `知识图谱存储不可用: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return [
    {
      name: 'knowledge_create_entities',
      description:
        '批量创建知识图谱实体。同名实体不会重复创建，会追加新的 observation（自动去重）。',
      parameters: z.object({ entities: z.array(entitySchema) }),
      parallelSafe: true,
      execute: (args) =>
        withStoreGuard(async () => {
          const { entities } = args as { entities: z.infer<typeof entitySchema>[] };
          s.createEntities(entities);
          return { ok: true, data: { created: entities.length } };
        }),
    },

    {
      name: 'knowledge_create_relations',
      description: '批量创建知识图谱关系（有向边）。自动去重，相同 from/to/type 不重复创建。',
      parameters: z.object({ relations: z.array(relationSchema) }),
      parallelSafe: true,
      execute: (args) =>
        withStoreGuard(async () => {
          const { relations } = args as { relations: z.infer<typeof relationSchema>[] };
          s.createRelations(relations);
          return { ok: true, data: { created: relations.length } };
        }),
    },

    {
      name: 'knowledge_search',
      description:
        '在知识图谱中搜索。按关键词匹配实体名称、类型和观察内容。返回匹配实体及关联关系，按相关度排序。',
      parameters: z.object({ query: z.string().min(1) }),
      parallelSafe: true,
      execute: (args) =>
        withStoreGuard(async () => {
          const { query } = args as { query: string };
          const results = s.search(query);
          return {
            ok: true,
            data: {
              query,
              results: results.map((r) => ({
                name: r.entity.name,
                entityType: r.entity.entityType,
                observations: r.entity.observations,
                score: r.score,
                relations: r.relations.map(
                  (rel) => `${rel.from} --[${rel.relationType}]--> ${rel.to}`,
                ),
              })),
            },
          };
        }),
    },

    {
      name: 'knowledge_open_nodes',
      description: '按名称打开知识图谱节点，返回实体的所有观察和关联关系。',
      parameters: z.object({ names: z.array(z.string().min(1)) }),
      parallelSafe: true,
      execute: (args) =>
        withStoreGuard(async () => {
          const { names } = args as { names: string[] };
          const graph = s.openNodes(names);
          // 请求的全部实体都不存在 → ENTITY_NOT_FOUND（部分存在则正常返回，保留已命中实体与关系）
          if (names.length > 0 && graph.entities.length === 0) {
            return toolError(
              ToolErrorCode.ENTITY_NOT_FOUND,
              `实体不存在: ${names.join('、')}（请先用 knowledge_search 搜索确认名称）`,
            );
          }
          return {
            ok: true,
            data: {
              entities: graph.entities.map((e) => ({
                name: e.name,
                entityType: e.entityType,
                observations: e.observations,
              })),
              relations: graph.relations.map((r) => `${r.from} --[${r.relationType}]--> ${r.to}`),
            },
          };
        }),
    },

    {
      name: 'knowledge_delete',
      description:
        '删除知识图谱中的实体、观察或关系。可同时删除多个。entities 按名称删除（含关联关系），observations 按 (entityName, content) 删除，relations 按 (from, to, relationType) 删除。',
      parameters: z.object({
        entities: z.array(z.string()).optional(),
        observations: z.array(observationDeletionSchema).optional(),
        relations: z.array(relationDeletionSchema).optional(),
      }),
      parallelSafe: true,
      execute: (args) =>
        withStoreGuard(async () => {
          const { entities, observations, relations } = args as {
            entities?: string[];
            observations?: z.infer<typeof observationDeletionSchema>[];
            relations?: z.infer<typeof relationDeletionSchema>[];
          };
          let deleted = 0;
          if (entities !== undefined && entities.length > 0) {
            s.deleteEntities(entities);
            deleted += entities.length;
          }
          if (observations !== undefined && observations.length > 0) {
            s.deleteObservations(observations);
            deleted += observations.length;
          }
          if (relations !== undefined && relations.length > 0) {
            s.deleteRelations(relations);
            deleted += relations.length;
          }
          return { ok: true, data: { deleted } };
        }),
    },
  ];
}
