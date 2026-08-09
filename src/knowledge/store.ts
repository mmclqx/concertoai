/**
 * 知识图谱存储层（v2.1 M4）。
 *
 * JSONL 文件持久化 + 内存索引快速查询。
 * 按项目隔离（projectHash → 独立存储文件）。
 * LRU 淘汰：实体数超过上限时移除最久未访问的。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type {
  KnowledgeEntity,
  KnowledgeGraph,
  KnowledgeObservation,
  KnowledgeObservationDeletion,
  KnowledgeRelation,
  KnowledgeRelationDeletion,
  KnowledgeSearchResult,
} from './types';

/** 默认最大实体数（超过时 LRU 淘汰）。 */
const MAX_ENTITIES = 1000;

/** 知识图谱存储目录。 */
function storeDir(): string {
  return path.join(homedir(), '.lumen', 'knowledge');
}

/** 按项目路径生成隔离文件名。 */
function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

function storeFile(cwd: string): string {
  return path.join(storeDir(), `${projectHash(cwd)}.jsonl`);
}

export class KnowledgeStore {
  private entities = new Map<string, KnowledgeEntity>();
  private relations: KnowledgeRelation[] = [];
  private readonly filePath: string;
  private dirty = false;

  constructor(cwd: string) {
    mkdirSync(storeDir(), { recursive: true });
    this.filePath = storeFile(cwd);
    this.loadFromDisk();
  }

  // ── CRUD：实体 ───────────────────────────────────────────

  /** 批量创建实体（同名则追加 observations）。 */
  createEntities(
    entities: Array<{ name: string; entityType: string; observations: string[] }>,
  ): void {
    for (const input of entities) {
      const existing = this.entities.get(input.name);
      if (existing !== undefined) {
        // 追加新 observation（去重）
        for (const obs of input.observations) {
          if (!existing.observations.includes(obs)) {
            existing.observations.push(obs);
          }
        }
        existing.lastAccessedAt = Date.now();
      } else {
        this.evictIfNeeded();
        this.entities.set(input.name, {
          name: input.name,
          entityType: input.entityType,
          observations: [...input.observations],
          lastAccessedAt: Date.now(),
        });
      }
    }
    this.dirty = true;
  }

  /** 获取指定实体。更新 lastAccessedAt。 */
  getEntity(name: string): KnowledgeEntity | undefined {
    const entity = this.entities.get(name);
    if (entity !== undefined) {
      entity.lastAccessedAt = Date.now();
    }
    return entity;
  }

  /** 按名称批量查询实体及关联关系。 */
  openNodes(names: string[]): KnowledgeGraph {
    const entities: KnowledgeEntity[] = [];
    const relations = this.relations.filter((r) => names.includes(r.from) || names.includes(r.to));
    for (const name of names) {
      const entity = this.entities.get(name);
      if (entity !== undefined) {
        entity.lastAccessedAt = Date.now();
        entities.push(entity);
      }
    }
    return { entities, relations };
  }

  /** 删除实体（及关联的关系）。 */
  deleteEntities(names: string[]): void {
    for (const name of names) {
      this.entities.delete(name);
    }
    this.relations = this.relations.filter((r) => !names.includes(r.from) && !names.includes(r.to));
    this.dirty = true;
  }

  // ── CRUD：观察 ───────────────────────────────────────────

  /** 为实体追加观察。 */
  addObservations(observations: KnowledgeObservation[]): void {
    for (const obs of observations) {
      const entity = this.entities.get(obs.entityName);
      if (entity === undefined) {
        continue;
      }
      for (const content of obs.contents) {
        if (!entity.observations.includes(content)) {
          entity.observations.push(content);
        }
      }
      entity.lastAccessedAt = Date.now();
    }
    this.dirty = true;
  }

  /** 删除实体的指定观察。 */
  deleteObservations(deletions: KnowledgeObservationDeletion[]): void {
    for (const del of deletions) {
      const entity = this.entities.get(del.entityName);
      if (entity === undefined) {
        continue;
      }
      entity.observations = entity.observations.filter((o) => !del.observations.includes(o));
      entity.lastAccessedAt = Date.now();
    }
    this.dirty = true;
  }

  // ── CRUD：关系 ───────────────────────────────────────────

  /** 批量创建关系（去重）。 */
  createRelations(relations: KnowledgeRelation[]): void {
    for (const rel of relations) {
      const exists = this.relations.some(
        (r) => r.from === rel.from && r.to === rel.to && r.relationType === rel.relationType,
      );
      if (!exists) {
        this.relations.push({ ...rel });
      }
    }
    this.dirty = true;
  }

  /** 删除指定关系。 */
  deleteRelations(deletions: KnowledgeRelationDeletion[]): void {
    this.relations = this.relations.filter(
      (r) =>
        !deletions.some(
          (d) => d.from === r.from && d.to === r.to && d.relationType === r.relationType,
        ),
    );
    this.dirty = true;
  }

  // ── 查询 ─────────────────────────────────────────────────

  /** 关键词搜索：匹配 entity name / entityType / observations。 */
  search(query: string): KnowledgeSearchResult[] {
    const q = query.toLowerCase();
    const results: KnowledgeSearchResult[] = [];

    for (const entity of this.entities.values()) {
      let score = 0;
      if (entity.name.toLowerCase().includes(q)) {
        score += 3;
      }
      if (entity.entityType.toLowerCase().includes(q)) {
        score += 1;
      }
      for (const obs of entity.observations) {
        const count = (
          obs.toLowerCase().match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []
        ).length;
        score += count;
      }
      if (score > 0) {
        entity.lastAccessedAt = Date.now();
        const rels = this.relations.filter((r) => r.from === entity.name || r.to === entity.name);
        results.push({ entity, relations: rels, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /** 导出完整图谱。 */
  readGraph(): KnowledgeGraph {
    return {
      entities: [...this.entities.values()],
      relations: [...this.relations],
    };
  }

  /** 获取实体总数。 */
  get entityCount(): number {
    return this.entities.size;
  }

  /** 获取关系总数。 */
  get relationCount(): number {
    return this.relations.length;
  }

  /** 持久化到磁盘。调用方应在合适的时机调用（如会话结束时）。 */
  flush(): void {
    if (!this.dirty) {
      return;
    }
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: 'meta', version: 1, savedAt: new Date().toISOString() }));
    for (const entity of this.entities.values()) {
      lines.push(JSON.stringify({ type: 'entity', ...entity }));
    }
    for (const rel of this.relations) {
      lines.push(JSON.stringify({ type: 'relation', ...rel }));
    }
    writeFileSync(this.filePath, `${lines.join('\n')}\n`, 'utf8');
    this.dirty = false;
  }

  // ── 内部方法 ─────────────────────────────────────────────

  /** 从磁盘加载已有数据。 */
  private loadFromDisk(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') {
          continue;
        }
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type === 'entity') {
            this.entities.set(obj.name as string, {
              name: obj.name as string,
              entityType: obj.entityType as string,
              observations: obj.observations as string[],
              lastAccessedAt: (obj.lastAccessedAt as number) ?? Date.now(),
            });
          } else if (obj.type === 'relation') {
            this.relations.push({
              from: obj.from as string,
              to: obj.to as string,
              relationType: obj.relationType as string,
            });
          }
        } catch {
          // 跳过损坏行
        }
      }
    } catch {
      // 文件不存在 → 首次使用
    }
  }

  /** LRU 淘汰：移除最久未访问的实体。 */
  private evictIfNeeded(): void {
    if (this.entities.size < MAX_ENTITIES) {
      return;
    }
    let oldest: { name: string; ts: number } | undefined;
    for (const [name, entity] of this.entities) {
      if (oldest === undefined || entity.lastAccessedAt < oldest.ts) {
        oldest = { name, ts: entity.lastAccessedAt };
      }
    }
    if (oldest !== undefined) {
      this.entities.delete(oldest.name);
      this.relations = this.relations.filter((r) => r.from !== oldest.name && r.to !== oldest.name);
    }
  }
}
