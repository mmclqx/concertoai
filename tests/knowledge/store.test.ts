/**
 * KnowledgeStore 单元测试（v2.1 M4）。
 *
 * 覆盖：实体/关系/观察 CRUD、搜索、LRU 淘汰、持久化。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KnowledgeStore } from '../../src/knowledge/store';

let tmp: string;
let store: KnowledgeStore;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-kg-test-'));
  store = new KnowledgeStore(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('KnowledgeStore CRUD', () => {
  it('createEntities — 创建实体 + 同名追加 observation', () => {
    store.createEntities([
      { name: 'module-a', entityType: 'module', observations: ['处理用户认证'] },
    ]);
    expect(store.entityCount).toBe(1);

    // 同名实体追加（去重）
    store.createEntities([
      { name: 'module-a', entityType: 'module', observations: ['处理用户认证', '使用 JWT'] },
    ]);
    expect(store.entityCount).toBe(1);

    const entity = store.getEntity('module-a');
    expect(entity?.observations).toHaveLength(2);
    expect(entity?.observations).toContain('处理用户认证');
    expect(entity?.observations).toContain('使用 JWT');
  });

  it('createRelations — 创建关系 + 去重', () => {
    store.createEntities([
      { name: 'A', entityType: 'module', observations: [] },
      { name: 'B', entityType: 'module', observations: [] },
    ]);
    store.createRelations([
      { from: 'A', to: 'B', relationType: 'depends_on' },
      { from: 'A', to: 'B', relationType: 'depends_on' }, // 重复
    ]);
    expect(store.relationCount).toBe(1);
  });

  it('openNodes — 按名称查询实体及关系', () => {
    store.createEntities([
      { name: 'X', entityType: 'concept', observations: ['X 描述'] },
      { name: 'Y', entityType: 'concept', observations: ['Y 描述'] },
    ]);
    store.createRelations([{ from: 'X', to: 'Y', relationType: 'references' }]);

    const graph = store.openNodes(['X']);
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0]?.name).toBe('X');
    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0]?.from).toBe('X');
  });

  it('deleteEntities — 删除实体及关联关系', () => {
    store.createEntities([{ name: 'Z', entityType: 'temp', observations: ['临时数据'] }]);
    store.createRelations([{ from: 'Z', to: 'X', relationType: 'links' }]);

    store.deleteEntities(['Z']);
    expect(store.entityCount).toBe(0);
    expect(store.getEntity('Z')).toBeUndefined();
    // 关系也应被清理
    const graph = store.readGraph();
    expect(graph.relations.length).toBe(0);
  });

  it('addObservations / deleteObservations — 追加与删除', () => {
    store.createEntities([{ name: 'note', entityType: 'note', observations: ['笔记 1'] }]);

    store.addObservations([{ entityName: 'note', contents: ['笔记 2', '笔记 3'] }]);
    expect(store.getEntity('note')?.observations).toHaveLength(3);

    store.deleteObservations([{ entityName: 'note', observations: ['笔记 2'] }]);
    expect(store.getEntity('note')?.observations).toHaveLength(2);
    expect(store.getEntity('note')?.observations).not.toContain('笔记 2');
  });

  it('search — 关键词匹配名称、类型、观察', () => {
    store.createEntities([
      { name: 'auth', entityType: 'module', observations: ['处理登录和注册'] },
      { name: 'database', entityType: 'module', observations: ['使用 SQLite 存储'] },
    ]);

    // 按名称匹配
    let results = store.search('auth');
    expect(results).toHaveLength(1);
    expect(results[0]?.entity.name).toBe('auth');

    // 按 observation 匹配
    results = store.search('SQLite');
    expect(results).toHaveLength(1);
    expect(results[0]?.entity.name).toBe('database');

    // 无匹配
    results = store.search('nosuch');
    expect(results).toHaveLength(0);
  });

  it('search — 结果携带邻接表关联关系（v2.1 性能优化）', () => {
    store.createEntities([
      { name: 'A', entityType: 'module', observations: ['核心模块'] },
      { name: 'B', entityType: 'module', observations: ['依赖 A'] },
    ]);
    store.createRelations([
      { from: 'A', to: 'B', relationType: 'depends_on' },
      { from: 'C', to: 'A', relationType: 'links' }, // C 实体不存在也允许索引
    ]);

    const results = store.search('A');
    expect(results).toHaveLength(2); // A（名称命中）与 B（observation 命中）
    const aResult = results.find((r) => r.entity.name === 'A');
    expect(aResult?.relations).toHaveLength(2);
    // 关系按 from/to 双向索引
    const bResult = results.find((r) => r.entity.name === 'B');
    expect(bResult?.relations).toHaveLength(1);
    expect(bResult?.relations[0]?.from).toBe('A');
  });

  it('deleteRelations — 邻接表同步更新（搜索不再返回已删关系）', () => {
    store.createEntities([{ name: 'A', entityType: 'module', observations: [] }]);
    store.createRelations([{ from: 'A', to: 'B', relationType: 'links' }]);
    expect(store.search('A')[0]?.relations).toHaveLength(1);

    store.deleteRelations([{ from: 'A', to: 'B', relationType: 'links' }]);
    expect(store.search('A')[0]?.relations).toHaveLength(0);
    expect(store.relationCount).toBe(0);
  });

  it('deleteEntities — 邻接表同步清理关联关系', () => {
    store.createEntities([{ name: 'X', entityType: 'temp', observations: [] }]);
    store.createRelations([{ from: 'X', to: 'Y', relationType: 'links' }]);
    store.deleteEntities(['X']);
    // 不存在的关系残留：search('Y') 无实体命中，且 relationCount 为 0
    expect(store.relationCount).toBe(0);
  });

  it('search — 空查询返回空数组（不产生误命中）', () => {
    store.createEntities([{ name: 'a', entityType: 't', observations: ['内容'] }]);
    expect(store.search('')).toHaveLength(0);
    expect(store.search('   ')).toHaveLength(0);
  });

  it('懒加载 — 构造不读盘，首次访问时加载（行为与构造即加载一致）', () => {
    // 前置：已有持久化数据
    store.createEntities([{ name: 'persist', entityType: 'test', observations: ['持久化'] }]);
    store.createRelations([{ from: 'persist', to: 'peer', relationType: 'has' }]);
    store.flush();

    // 新实例：构造后立即写入不应覆盖磁盘数据（懒加载保证先读后写）
    const store2 = new KnowledgeStore(tmp);
    store2.createEntities([{ name: 'extra', entityType: 'test', observations: [] }]);
    expect(store2.entityCount).toBe(2); // persist + extra（含磁盘数据）

    // 懒加载完成后可正常查询与计数
    expect(store2.getEntity('persist')?.observations).toContain('持久化');
    expect(store2.relationCount).toBe(1);
  });

  it('LRU 淘汰 — 超过上限时移除最久未访问', () => {
    // 批量创建 > MAX_ENTITIES 实体
    const count = 1002;
    for (let i = 0; i < count; i++) {
      store.createEntities([{ name: `entity-${i}`, entityType: 'test', observations: [] }]);
    }
    // 应被 LRU 裁剪到 MAX_ENTITIES
    expect(store.entityCount).toBeLessThan(count);
  });

  it('flush + load — 持久化与恢复', () => {
    store.createEntities([{ name: 'persist', entityType: 'test', observations: ['持久化测试'] }]);
    store.createRelations([{ from: 'persist', to: 'some', relationType: 'has' }]);
    store.flush();

    // 从同一文件重新加载
    const store2 = new KnowledgeStore(tmp);
    expect(store2.entityCount).toBe(1);
    expect(store2.getEntity('persist')?.observations).toContain('持久化测试');
    expect(store2.relationCount).toBe(1);
  });
});
