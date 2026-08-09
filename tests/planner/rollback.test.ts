/**
 * SnapshotStore 回滚测试。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SnapshotStore } from '../../src/planner/rollback';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-rollback-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('SnapshotStore', () => {
  it('snapshot 后回滚恢复原内容', async () => {
    const file = 'test.txt';
    const filePath = path.join(tmp, file);
    const original = '原始内容';

    writeFileSync(filePath, original, 'utf8');
    const store = new SnapshotStore('session-1', tmp);

    await store.snapshot(file, tmp);

    // 修改文件
    writeFileSync(filePath, '修改后的内容', 'utf8');

    // 回滚
    const result = await store.rollback(tmp);
    expect(result.restored).toContain(file);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('新增文件回滚时删除', async () => {
    const file = 'new.txt';
    const filePath = path.join(tmp, file);
    const store = new SnapshotStore('session-1', tmp);

    // 快照不存在的文件（模拟新增文件场景）
    await store.snapshot(file, tmp);

    // 创建文件
    writeFileSync(filePath, '新内容', 'utf8');
    expect(() => readFileSync(filePath)).not.toThrow();

    // 回滚应删除
    await store.rollback(tmp);
    expect(() => readFileSync(filePath)).toThrow();
  });

  it('同一文件只快照一次（保留原始版本）', async () => {
    const file = 'test.txt';
    const filePath = path.join(tmp, file);
    writeFileSync(filePath, '版本1', 'utf8');

    const store = new SnapshotStore('session-1', tmp);
    await store.snapshot(file, tmp); // 快照版本1

    // 修改 + 再次快照（应保留版本1）
    writeFileSync(filePath, '版本2', 'utf8');
    await store.snapshot(file, tmp); // 不应覆盖

    // 再次修改后回滚
    writeFileSync(filePath, '版本3', 'utf8');
    await store.rollback(tmp);
    expect(readFileSync(filePath, 'utf8')).toBe('版本1');
  });

  it('cleanup 删除快照目录', async () => {
    const file = 'test.txt';
    writeFileSync(path.join(tmp, file), '内容', 'utf8');
    const store = new SnapshotStore('session-1', tmp);

    await store.snapshot(file, tmp);
    await store.cleanup();

    // 快照目录已被删除
    const snapDir = path.join(tmp, '.concertoai/snapshots/session-1');
    expect(() => readFileSync(snapDir)).toThrow();
  });

  it('无快照时 rollback 返回空结果', async () => {
    const store = new SnapshotStore('session-1', tmp);
    const result = await store.rollback(tmp);
    expect(result.restored).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});
