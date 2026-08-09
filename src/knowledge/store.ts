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
  /**
   * v2.1 性能优化：关系邻接表（name → 关联关系），
   * 消除 search/openNodes 中 O(实体数 × 关系数) 的重复 filter，降至 O(1) 查询。
   */
  private relationIndex = new Map<string, KnowledgeRelation[]>();
  /**
   * 懒加载标志：构造函数不读盘（首帧优化），首次读取/写入前按需加载。
   * 所有公开方法入口调用 ensureLoaded() 保证行为与构造即加载一致。
   */
  private loaded = false;

  constructor(cwd: string) {
    mkdirSync(storeDir(), { recursive: true });
    this.filePath = storeFile(cwd);
    // 懒加载：构造不读盘，首次查询/写入时才加载（启动首帧性能优化）
  }

  // ── CRUD：实体 ───────────────────────────────────────────

  /** 批量创建实体（同名则追加 observations）。 */
  createEntities(
    entities: Array<{ name: string; entityType: string; observations: string[] }>,
  ): void {
    this.ensureLoaded();
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
    this.ensureLoaded();
    const entity = this.entities.get(name);
    if (entity !== undefined) {
      entity.lastAccessedAt = Date.now();
    }
    return entity;
  }

  /** 按名称批量查询实体及关联关系。 */
  openNodes(names: string[]): KnowledgeGraph {
    this.ensureLoaded();
    const entities: KnowledgeEntity[] = [];
    // 用 Set 加速成员判断，避免 O(names × relations) 的 includes 扫描
    const nameSet = new Set(names);
    const relations = this.relations.filter((r) => nameSet.has(r.from) || nameSet.has(r.to));
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
    this.ensureLoaded();
    const nameSet = new Set(names);
    for (const name of nameSet) {
      this.entities.delete(name);
    }
    this.relations = this.relations.filter((r) => !nameSet.has(r.from) && !nameSet.has(r.to));
    this.rebuildRelationIndex();
    this.dirty = true;
  }

  // ── CRUD：观察 ───────────────────────────────────────────

  /** 为实体追加观察。 */
  addObservations(observations: KnowledgeObservation[]): void {
    this.ensureLoaded();
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
    this.ensureLoaded();
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
    this.ensureLoaded();
    for (const rel of relations) {
      const exists = this.relations.some(
        (r) => r.from === rel.from && r.to === rel.to && r.relationType === rel.relationType,
      );
      if (!exists) {
        this.relations.push({ ...rel });
        this.indexRelation(rel);
      }
    }
    this.dirty = true;
  }

  /** 删除指定关系。 */
  deleteRelations(deletions: KnowledgeRelationDeletion[]): void {
    this.ensureLoaded();
    const delSet = new Set(
      deletions.map((d) => `${d.from}\u0000${d.to}\u0000${d.relationType}`),
    );
    this.relations = this.relations.filter(
      (r) => !delSet.has(`${r.from}\u0000${r.to}\u0000${r.relationType}`),
    );
    this.rebuildRelationIndex();
    this.dirty = true;
  }

  // ── 查询 ─────────────────────────────────────────────────

  /** 关键词搜索：匹配 entity name / entityType / observations。 */
  search(query: string): KnowledgeSearchResult[] {
    this.ensureLoaded();
    const q = query.toLowerCase().trim();
    const results: KnowledgeSearchResult[] = [];

    // 空查询直接返回（避免 split('') 按字符拆分产生误命中）
    if (q === '') {
      return results;
    }

    // 观测文本中关键词出现次数：用 split 计数，避免逐条构建正则的开销
    for (const entity of this.entities.values()) {
      let score = 0;
      if (entity.name.toLowerCase().includes(q)) {
        score += 3;
      }
      if (entity.entityType.toLowerCase().includes(q)) {
        score += 1;
      }
      for (const obs of entity.observations) {
        score += obs.toLowerCase().split(q).length - 1;
      }
      if (score > 0) {
        entity.lastAccessedAt = Date.now();
        // 邻接表 O(1) 查询关联关系（v2.1 性能优化）
        const rels = this.relationIndex.get(entity.name) ?? [];
        results.push({ entity, relations: rels, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /** 导出完整图谱。 */
  readGraph(): KnowledgeGraph {
    this.ensureLoaded();
    return {
      entities: [...this.entities.values()],
      relations: [...this.relations],
    };
  }

  /** 获取实体总数。 */
  get entityCount(): number {
    this.ensureLoaded();
    return this.entities.size;
  }

  /** 获取关系总数。 */
  get relationCount(): number {
    this.ensureLoaded();
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

  /** 懒加载：首次访问前从磁盘加载。幂等，重复调用无副作用。 */
  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loadFromDisk();
      this.loaded = true;
    }
  }

  /** 把单条关系加入邻接表（from/to 两个方向）。 */
  private indexRelation(rel: KnowledgeRelation): void {
    const push = (name: string) => {
      const list = this.relationIndex.get(name);
      if (list === undefined) {
        this.relationIndex.set(name, [rel]);
      } else {
        list.push(rel);
      }
    };
    push(rel.from);
    push(rel.to);
  }

  /** 依据 relations 全量重建邻接表（删除/淘汰后调用；关系规模小，重建成本可接受）。 */
  private rebuildRelationIndex(): void {
    this.relationIndex = new Map<string, KnowledgeRelation[]>();
    for (const rel of this.relations) {
      this.indexRelation(rel);
    }
  }

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
      this.rebuildRelationIndex();
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
      this.rebuildRelationIndex();
    }
  }
}
