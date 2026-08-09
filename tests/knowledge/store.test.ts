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
