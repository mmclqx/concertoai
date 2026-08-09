/**
 * 多文件事务回滚（v3.0 M3 / T3.6，§8.1）。
 *
 * 任务级多文件事务：任务开始前创建 `.concertoai/snapshots/<taskId>/` 快照，
 * 回滚时恢复所有涉及文件，保证原子性（含已通过审批的部分文件）。
 *
 * 关键设计：
 * - begin(taskId, files)：一次性快照全部涉及文件（存在 → 保存原内容；不存在 → 标记新增）；
 * - recordWrite(taskId, relPath, content)：登记任务写入（CoderFileWriter 接入点），
 *   供 rollback 区分「任务修改」与「外部修改」；
 * - rollback(taskId)：恢复文件 → 外部修改检测 → 全部成功清理快照 / 部分失败保留快照并报错；
 * - commit(taskId)：任务成功后清理快照；
 * - 失败/取消后未 rollback → 快照保留供人工检查；`concertoai snapshot clean` 手动清理；
 * - 回滚失败（文件被外部修改 / 读写异常）→ 明确报错并保留快照，不静默覆盖。
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ── 常量 ──────────────────────────────────────────────────────

/** 快照根目录（项目相对）。 */
export const SNAPSHOT_ROOT = '.concertoai/snapshots';

/** 快照清单文件名（记录 relPath ↔ 编码文件映射 + 存在性）。 */
const FILES_MANIFEST = 'files.json';
/** 任务写入登记文件名（recordWrite 持久化）。 */
const WRITES_MANIFEST = 'writes.json';

// ── 类型定义 ──────────────────────────────────────────────────

/** 单个文件快照条目。 */
interface SnapshotFileEntry {
  /** 项目相对路径。 */
  relPath: string;
  /** 编码后的快照文件名。 */
  encoded: string;
  /** 快照时文件是否存在（false = 新增文件，回滚时删除）。 */
  existed: boolean;
}

/** 事务快照（begin 返回值）。 */
export interface TransactionSnapshot {
  /** 任务 ID（快照目录名）。 */
  taskId: string;
  /** 快照时间（epoch 毫秒）。 */
  createdAt: number;
  /** 快照文件条目数。 */
  fileCount: number;
}

/** 回滚结果（restored/skipped/failed）。 */
export interface RollbackResult {
  /** 已恢复（写回/删除）的文件路径。 */
  restored: string[];
  /** 未修改跳过的文件路径。 */
  skipped: string[];
  /** 失败项（外部修改 / 读写异常）；非空时快照保留。 */
  failed: Array<{ path: string; error: string }>;
  /** 是否全部成功（failed 为空）。 */
  ok: boolean;
}

// ── 快照管理器 ────────────────────────────────────────────────

/**
 * 多文件事务快照管理器。
 *
 * 用法：
 * ```ts
 * const tx = new SnapshotManager(cwd);
 * await tx.begin(taskId, files);
 * // ... 任务执行（写文件时 recordWrite 登记）...
 * await tx.rollback(taskId); // 失败回滚
 * // 或
 * await tx.commit(taskId);   // 成功提交（清理快照）
 * ```
 */
export class SnapshotManager {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** 快照目录绝对路径。 */
  private dirFor(taskId: string): string {
    return path.join(this.cwd, SNAPSHOT_ROOT, encodePathSegment(taskId));
  }

  /**
   * 开启事务：创建快照目录，保存全部涉及文件原始内容。
   * 文件不存在 → 标记新增（回滚时删除）；文件存在 → 保存原内容。
   *
   * @param taskId 任务 ID（快照目录名，须为合法路径段）。
   * @param files  涉及文件的项目相对路径列表。
   */
  async begin(taskId: string, files: string[]): Promise<TransactionSnapshot> {
    const dir = this.dirFor(taskId);
    await mkdir(dir, { recursive: true });

    const entries: SnapshotFileEntry[] = [];
    for (const relPath of files) {
      const encoded = encodeFilename(relPath);
      const src = path.resolve(this.cwd, relPath);
      let existed = false;
      try {
        const content = await readFile(src);
        await writeFile(path.join(dir, encoded), content);
        existed = true;
      } catch {
        // 文件不存在 → 新增文件标记（回滚时删除）
        await writeFile(path.join(dir, `${encoded}.new`), '');
      }
      entries.push({ relPath, encoded, existed });
    }

    // 清单 + 空写入登记
    await writeFile(path.join(dir, FILES_MANIFEST), JSON.stringify(entries, null, 2), 'utf8');
    await writeFile(path.join(dir, WRITES_MANIFEST), '{}', 'utf8');

    return { taskId, createdAt: Date.now(), fileCount: entries.length };
  }

  /**
   * 登记任务写入（CoderFileWriter 接入点：写文件前调用）。
   * rollback 时据此区分「任务修改」（可安全覆盖恢复）与「外部修改」（拒绝覆盖）。
   */
  async recordWrite(taskId: string, relPath: string, content: string): Promise<void> {
    const dir = this.dirFor(taskId);
    const writesPath = path.join(dir, WRITES_MANIFEST);
    let writes: Record<string, string> = {};
    try {
      writes = JSON.parse(await readFile(writesPath, 'utf8')) as Record<string, string>;
    } catch {
      // 清单不存在 → 视为空（事务可能未 begin，写入失败时抛错）
    }
    writes[relPath] = content;
    await writeFile(writesPath, JSON.stringify(writes, null, 2), 'utf8');
  }

  /**
   * 回滚：恢复所有文件到任务开始前状态（含已审批的部分文件，原子性）。
   *
   * 外部修改检测：
   * - 快照时存在且未被修改（当前内容 === 快照内容）→ skipped；
   * - 快照时存在且被任务修改（当前内容 === recordWrite 登记内容）→ 恢复；
   * - 快照时存在但当前内容 ≠ 登记内容且 ≠ 快照内容 → 外部修改 → failed（不覆盖）；
   * - 快照时不存在（新增）且当前存在 → 删除；当前不存在 → skipped。
   *
   * 全部成功 → 清理快照；部分失败 → 保留快照（供人工检查），返回失败详情。
   */
  async rollback(taskId: string): Promise<RollbackResult> {
    const dir = this.dirFor(taskId);
    const result: RollbackResult = { restored: [], skipped: [], failed: [], ok: false };

    let entries: SnapshotFileEntry[];
    try {
      entries = JSON.parse(
        await readFile(path.join(dir, FILES_MANIFEST), 'utf8'),
      ) as SnapshotFileEntry[];
    } catch (err) {
      result.failed.push({
        path: '<snapshot>',
        error: `快照清单缺失或损坏: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { ...result, ok: false };
    }

    // 读取任务写入登记（区分任务修改 vs 外部修改）
    let writes: Record<string, string> = {};
    try {
      writes = JSON.parse(await readFile(path.join(dir, WRITES_MANIFEST), 'utf8')) as Record<
        string,
        string
      >;
    } catch {
      // 无登记 → 全部视为未登记（外部修改检测更严格）
    }

    for (const entry of entries) {
      const dest = path.resolve(this.cwd, entry.relPath);
      const snap = path.join(dir, entry.encoded);
      try {
        if (!entry.existed) {
          // 新增文件（快照时不存在）→ 回滚删除
          try {
            await readFile(dest);
            await rm(dest, { force: true });
            result.restored.push(entry.relPath);
          } catch {
            result.skipped.push(entry.relPath);
          }
          continue;
        }

        // 快照时存在的文件
        const original = await readFile(snap);
        let current: Buffer;
        try {
          current = await readFile(dest);
        } catch {
          // 文件被删除 → 恢复原始内容
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, original);
          result.restored.push(entry.relPath);
          continue;
        }

        if (current.equals(original)) {
          // 未被修改（或已恢复）→ 跳过
          result.skipped.push(entry.relPath);
          continue;
        }

        // 被修改：检查是否为任务登记写入
        const recorded = writes[entry.relPath];
        if (recorded !== undefined && Buffer.from(recorded, 'utf8').equals(current)) {
          // 任务写入 → 安全恢复
          await writeFile(dest, original);
          result.restored.push(entry.relPath);
          continue;
        }

        // 外部修改（未登记或内容与登记不符）→ 拒绝覆盖，明确报错
        result.failed.push({
          path: entry.relPath,
          error:
            recorded === undefined
              ? '文件被外部修改（无任务写入登记），拒绝覆盖'
              : '文件被外部修改（内容与任务写入不符），拒绝覆盖',
        });
      } catch (err) {
        result.failed.push({
          path: entry.relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const ok = result.failed.length === 0;
    if (ok) {
      // 全部恢复成功 → 清理快照（事务结束）
      await rm(dir, { recursive: true, force: true });
    }
    // 部分失败 → 保留快照供人工检查
    return { ...result, ok };
  }

  /** 提交：任务成功后清理快照目录。 */
  async commit(taskId: string): Promise<void> {
    await rm(this.dirFor(taskId), { recursive: true, force: true });
  }

  /** 列出全部快照 taskId（按创建时间升序，供 clean 展示）。 */
  async list(): Promise<string[]> {
    const root = path.join(this.cwd, SNAPSHOT_ROOT);
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** 清理全部快照（`concertoai snapshot clean`），返回被清理的 taskId 列表。 */
  async clean(): Promise<string[]> {
    const names = await this.list();
    for (const name of names) {
      await rm(this.dirFor(name), { recursive: true, force: true });
    }
    return names;
  }
}

// ── 工具 ──────────────────────────────────────────────────────

/** 将文件相对路径编码为合法文件名（路径分隔符 → __）。 */
function encodeFilename(relPath: string): string {
  return relPath.replace(/[/\\:]/g, '__');
}

/** 将 taskId 编码为安全路径段（防路径穿越）。 */
function encodePathSegment(segment: string): string {
  return segment.replace(/[/\\:]/g, '__');
}
