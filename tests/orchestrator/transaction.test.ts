/**
 * 多文件事务回滚测试（v3.0 M3 / T3.6）。
 *
 * 覆盖验收标准：
 * - beginTransaction：任务开始前创建 .concertoai/snapshots/<taskId>/，保存涉及文件原始内容；
 * - rollback：恢复所有文件到任务开始前状态（含已审批的部分文件，原子性）；
 * - commit：任务成功后清理快照；
 * - 失败/取消后保留快照供人工检查（未 rollback / rollback 失败均保留）；
 * - clean：手动清理全部过期快照；
 * - 回滚失败（文件被外部修改）→ 明确报错并保留快照，不静默覆盖。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_ROOT, SnapshotManager } from '../../src/orchestrator';

// ── 测试辅助 ──────────────────────────────────────────────────

/** 临时工作目录（每个测试独立）。 */
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'concertoai-tx-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** 写一个文件。 */
async function write(relPath: string, content: string): Promise<void> {
  const full = path.join(cwd, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

/** 读一个文件（不存在返回 undefined）。 */
async function read(relPath: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(cwd, relPath), 'utf8');
  } catch {
    return undefined;
  }
}

/** 快照目录是否存在。 */
async function snapshotExists(taskId: string): Promise<boolean> {
  try {
    await readFile(path.join(cwd, SNAPSHOT_ROOT, taskId, 'files.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── begin ─────────────────────────────────────────────────────

describe('begin（创建快照）', () => {
  it('保存涉及文件原始内容到 .concertoai/snapshots/<taskId>/', async () => {
    await write('src/a.ts', '原内容A');
    await write('src/b.ts', '原内容B');
    const tx = new SnapshotManager(cwd);
    const snap = await tx.begin('task-1', ['src/a.ts', 'src/b.ts']);

    expect(snap.taskId).toBe('task-1');
    expect(snap.fileCount).toBe(2);
    expect(await snapshotExists('task-1')).toBe(true);
  });

  it('文件不存在 → 标记新增（回滚时删除）', async () => {
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-new', ['src/new.ts']);
    // 无原始内容文件，只有清单
    expect(await snapshotExists('task-new')).toBe(true);
  });

  it('taskId 含路径分隔符 → 编码为安全目录名（防路径穿越）', async () => {
    const tx = new SnapshotManager(cwd);
    await tx.begin('a/b:1', ['src/a.ts']);
    // 编码后目录存在
    const names = await tx.list();
    expect(names).toEqual(['a__b__1']);
  });
});

// ── rollback：恢复 ────────────────────────────────────────────

describe('rollback（恢复文件）', () => {
  it('任务修改的文件 → 恢复为原始内容（含已审批部分，原子性）', async () => {
    await write('src/a.ts', '原A');
    await write('src/b.ts', '原B');
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/a.ts', 'src/b.ts']);

    // 任务写文件（登记）
    await tx.recordWrite('task-1', 'src/a.ts', '新A');
    await write('src/a.ts', '新A');
    await tx.recordWrite('task-1', 'src/b.ts', '新B');
    await write('src/b.ts', '新B');

    const result = await tx.rollback('task-1');
    expect(result.ok).toBe(true);
    expect(result.restored).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(await read('src/a.ts')).toBe('原A');
    expect(await read('src/b.ts')).toBe('原B');
    // 回滚成功 → 快照清理
    expect(await snapshotExists('task-1')).toBe(false);
  });

  it('新增文件 → 回滚时删除', async () => {
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-new', ['src/new.ts']);
    await tx.recordWrite('task-new', 'src/new.ts', '内容');
    await write('src/new.ts', '内容');

    const result = await tx.rollback('task-new');
    expect(result.ok).toBe(true);
    expect(result.restored).toContain('src/new.ts');
    expect(await read('src/new.ts')).toBeUndefined();
  });

  it('未修改的文件 → skipped（无需恢复）', async () => {
    await write('src/unchanged.ts', '保持');
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/unchanged.ts']);

    const result = await tx.rollback('task-1');
    expect(result.ok).toBe(true);
    expect(result.skipped).toContain('src/unchanged.ts');
    expect(await read('src/unchanged.ts')).toBe('保持');
  });

  it('快照时存在但被删除的文件 → 恢复原始内容', async () => {
    await write('src/a.ts', '原A');
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/a.ts']);
    await rm(path.join(cwd, 'src/a.ts')); // 删除

    const result = await tx.rollback('task-1');
    expect(result.ok).toBe(true);
    expect(result.restored).toContain('src/a.ts');
    expect(await read('src/a.ts')).toBe('原A');
  });
});

// ── rollback：外部修改检测（不静默覆盖）──────────────────────

describe('rollback（外部修改检测）', () => {
  it('文件被外部修改（无任务写入登记）→ failed，保留快照，不覆盖', async () => {
    await write('src/a.ts', '原A');
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/a.ts']);

    // 外部直接改文件（未 recordWrite）
    await write('src/a.ts', '外部改');

    const result = await tx.rollback('task-1');
    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain('外部修改');
    // 不覆盖外部修改
    expect(await read('src/a.ts')).toBe('外部改');
    // 保留快照供人工检查
    expect(await snapshotExists('task-1')).toBe(true);
  });

  it('文件被外部修改（内容与任务写入不符）→ failed，保留快照', async () => {
    await write('src/a.ts', '原A');
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/a.ts']);
    await tx.recordWrite('task-1', 'src/a.ts', '任务写');
    await write('src/a.ts', '任务写');

    // 外部在任务写入后又修改
    await write('src/a.ts', '外部覆盖');

    const result = await tx.rollback('task-1');
    expect(result.ok).toBe(false);
    expect(result.failed[0]?.error).toContain('外部修改');
    expect(await read('src/a.ts')).toBe('外部覆盖');
    expect(await snapshotExists('task-1')).toBe(true);
  });

  it('快照清单缺失 → 回滚报错', async () => {
    const tx = new SnapshotManager(cwd);
    await mkdir(path.join(cwd, SNAPSHOT_ROOT, 'ghost'), { recursive: true });
    const result = await tx.rollback('ghost');
    expect(result.ok).toBe(false);
    expect(result.failed[0]?.error).toContain('快照清单缺失');
  });
});

// ── commit / clean / 保留 ─────────────────────────────────────

describe('commit / clean / 保留快照', () => {
  it('commit：任务成功后清理快照', async () => {
    await write('src/a.ts', '原A');
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/a.ts']);
    expect(await snapshotExists('task-1')).toBe(true);

    await tx.commit('task-1');
    expect(await snapshotExists('task-1')).toBe(false);
  });

  it('失败/取消但未 rollback → 快照保留供人工检查', async () => {
    await write('src/a.ts', '原A');
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/a.ts']);
    // 任务失败，不调用 rollback（保留快照供人工检查）
    expect(await snapshotExists('task-1')).toBe(true);
  });

  it('list：列出全部快照 taskId', async () => {
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/a.ts']);
    await tx.begin('task-2', ['src/b.ts']);
    const names = await tx.list();
    expect(names).toEqual(['task-1', 'task-2']);
  });

  it('clean：清理全部快照，返回被清理的 taskId', async () => {
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-1', ['src/a.ts']);
    await tx.begin('task-2', ['src/b.ts']);
    const cleaned = await tx.clean();
    expect(cleaned).toEqual(['task-1', 'task-2']);
    expect(await tx.list()).toEqual([]);
  });

  it('无快照时 list/clean 均返回空', async () => {
    const tx = new SnapshotManager(cwd);
    expect(await tx.list()).toEqual([]);
    expect(await tx.clean()).toEqual([]);
  });
});
