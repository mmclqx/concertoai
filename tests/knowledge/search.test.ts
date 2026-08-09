import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KnowledgeSearch } from '../../src/knowledge/search';
import { KnowledgeStore } from '../../src/knowledge/store';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-kg-search-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('KnowledgeSearch（邻接表加权，v2.1 性能优化）', () => {
  it('关系更多的实体获得更高的关联度加权（无需 readGraph 全图遍历）', () => {
    const store = new KnowledgeStore(tmp);
    store.createEntities([
      { name: 'hub', entityType: 'module', observations: ['中心模块'] },
      { name: 'leaf', entityType: 'module', observations: ['外围模块'] },
    ]);
    store.createRelations([
      { from: 'hub', to: 'a', relationType: 'links' },
      { from: 'hub', to: 'b', relationType: 'links' },
      { from: 'hub', to: 'c', relationType: 'links' },
      { from: 'leaf', to: 'x', relationType: 'links' },
    ]);

    const results = new KnowledgeSearch(store).search('模块', 10);
    const hub = results.find((r) => r.entity.name === 'hub');
    const leaf = results.find((r) => r.entity.name === 'leaf');
    expect(hub).toBeDefined();
    expect(leaf).toBeDefined();
    // 关键词命中得分相同（obs 各 1 次），hub 关系更多 → 关联度加权后得分更高
    expect(hub?.score).toBeGreaterThan(leaf?.score ?? 0);
  });

  it('无关系的实体得分不受影响（0 条关系加权为 0）', () => {
    const store = new KnowledgeStore(tmp);
    store.createEntities([{ name: 'solo', entityType: 'module', observations: ['独立'] }]);

    const results = new KnowledgeSearch(store).search('独立');
    expect(results[0]?.entity.name).toBe('solo');
    // 1（观察命中）+ 0 关系加权 = 1
    expect(results[0]?.score).toBe(1);
  });

  it('limit 截断生效', () => {
    const store = new KnowledgeStore(tmp);
    for (let i = 0; i < 30; i += 1) {
      store.createEntities([{ name: `e${i}`, entityType: 't', observations: [`关键词${i}`] }]);
    }
    const results = new KnowledgeSearch(store).search('关键词', 5);
    expect(results).toHaveLength(5);
  });

  it('空查询返回空数组（不产生误命中）', () => {
    const store = new KnowledgeStore(tmp);
    store.createEntities([{ name: 'a', entityType: 't', observations: ['x'] }]);
    expect(new KnowledgeSearch(store).search('')).toHaveLength(0);
    expect(new KnowledgeSearch(store).search('   ')).toHaveLength(0);
  });

  it('结果按 score 降序排列', () => {
    const store = new KnowledgeStore(tmp);
    // low：观察命中 1 次；high：名称命中 3 + 观察命中 1 + 关系加权
    store.createEntities([
      { name: 'alpha', entityType: 't', observations: ['target 弱相关'] },
      { name: 'target', entityType: 't', observations: ['target 强相关'] },
    ]);
    store.createRelations([{ from: 'target', to: 'peer', relationType: 'links' }]);

    const results = new KnowledgeSearch(store).search('target');
    expect(results[0]?.entity.name).toBe('target');
    expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score ?? 0);
  });

  it('快速排除路径与旧语义一致：观察文本混合大小写计数不变', () => {
    const store = new KnowledgeStore(tmp);
    store.createEntities([
      // 原始文本含小写 needle（走 includes 快速命中路径）
      { name: 'a', entityType: 't', observations: ['world world 出现两次'] },
      // 原始文本不含小写 needle，仅大写形式（走 toLowerCase 降级路径）
      { name: 'b', entityType: 't', observations: ['World Wide Web 大写'] },
      // 混合大小写：原始含小写，另有大写变体
      { name: 'c', entityType: 't', observations: ['World world 混合'] },
      // 完全不命中
      { name: 'd', entityType: 't', observations: ['无关内容'] },
    ]);

    const results = new KnowledgeSearch(store).search('world');
    const byName = new Map(results.map((r) => [r.entity.name, r.score]));
    // 观察命中次数（不含名称/类型加权：名称 a/b/c/d 与类型 t 均不包含 world）
    expect(byName.get('a')).toBe(2);
    expect(byName.get('b')).toBe(1);
    expect(byName.get('c')).toBe(2);
    expect(byName.has('d')).toBe(false);
  });
});
