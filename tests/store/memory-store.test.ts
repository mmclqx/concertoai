/**
 * MemoryStore 单元测试。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore } from '../../src/store/memory-store';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-memory-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function createStore(): MemoryStore {
  return new MemoryStore({ cwd: tmp });
}

describe('MemoryStore CRUD', () => {
  it('create 创建记忆并返回完整对象', async () => {
    const store = createStore();
    const entry = await store.create('标题', '内容', ['tag1']);
    expect(entry.id).toBeTruthy();
    expect(entry.title).toBe('标题');
    expect(entry.content).toBe('内容');
    expect(entry.tags).toEqual(['tag1']);
    expect(entry.createdAt).toBeTruthy();
  });

  it('list 返回所有记忆（最新在前）', async () => {
    const store = createStore();
    await store.create('旧', 'old');
    await new Promise((r) => setTimeout(r, 10));
    await store.create('新', 'new');

    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all[0]?.title).toBe('新');
    expect(all[1]?.title).toBe('旧');
  });

  it('get 按 id 查找', async () => {
    const store = createStore();
    const entry = await store.create('查找', 'content');
    const found = await store.get(entry.id);
    expect(found?.title).toBe('查找');
  });

  it('update 修改字段', async () => {
    const store = createStore();
    const entry = await store.create('原', 'old', ['a']);
    const updated = await store.update(entry.id, { title: '新', tags: ['b'] });
    expect(updated?.title).toBe('新');
    expect(updated?.content).toBe('old');
    expect(updated?.tags).toEqual(['b']);
  });

  it('delete 删除记忆', async () => {
    const store = createStore();
    const entry = await store.create('删', 'del');
    const ok = await store.delete(entry.id);
    expect(ok).toBe(true);
    const all = await store.list();
    expect(all).toHaveLength(0);
  });

  it('delete 不存在的 id 返回 false', async () => {
    const store = createStore();
    const ok = await store.delete('no-such-id');
    expect(ok).toBe(false);
  });
});

describe('MemoryStore 检索', () => {
  it('search 标题关键词匹配', async () => {
    const store = createStore();
    await store.create('项目架构', '内容A');
    await store.create('测试计划', '内容B');
    await store.create('API 文档', '内容C');

    const results = await store.search('架构');
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('项目架构');
  });

  it('search 内容关键词匹配', async () => {
    const store = createStore();
    await store.create('A', '关于 DeepSeek 模型');
    await store.create('B', '关于 OpenAI');

    const results = await store.search('DeepSeek');
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('A');
  });

  it('search 标签过滤', async () => {
    const store = createStore();
    await store.create('A', '内容', ['react', 'typescript']);
    await store.create('B', '内容', ['python']);

    const results = await store.search('', { tags: ['react'] });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('A');
  });

  it('search 按 limit 截断', async () => {
    const store = createStore();
    for (let i = 0; i < 10; i++) {
      await store.create(`记忆${i}`, `关于 项目 的 ${i}`);
    }
    const results = await store.search('项目', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe('MemoryStore 隔离', () => {
  it('不同 cwd 的 MemoryStore 互不干扰', async () => {
    const tmp2 = mkdtempSync(path.join(os.tmpdir(), 'concertoai-memory2-'));
    try {
      const s1 = new MemoryStore({ cwd: tmp });
      const s2 = new MemoryStore({ cwd: tmp2 });

      await s1.create('来自项目1', 'c1');
      await s2.create('来自项目2', 'c2');

      const list1 = await s1.list();
      const list2 = await s2.list();

      expect(list1).toHaveLength(1);
      expect(list1[0]?.title).toBe('来自项目1');
      expect(list2).toHaveLength(1);
      expect(list2[0]?.title).toBe('来自项目2');
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
