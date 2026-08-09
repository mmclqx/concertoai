/**
 * 计划执行回滚：文件快照 → 失败时恢复。
 *
 * 策略：
 * - 计划执行前创建快照目录 `.concertoai/snapshots/<id>/`
 * - 每次 edit_file 操作前自动快照原文件（若文件存在且未被快照过）
 * - 回滚时逐文件从快照恢复，非文件操作（shell）跳过并提示
 * - 正常完成后自动清理快照目录
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 快照目录前缀。 */
export const SNAPSHOT_DIR = '.concertoai/snapshots';

// ── 快照管理器 ──

export class SnapshotStore {
  private readonly dir: string;
  private readonly taken = new Set<string>();

  constructor(sessionId: string, cwd: string) {
    this.dir = path.join(cwd, SNAPSHOT_DIR, sessionId);
  }

  /** 确保快照目录存在。 */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * 快照指定文件（项目相对路径）。
   * 同一文件在同一计划中只快照一次（保留修改前的原始状态）。
   * 文件不存在时仅记录（回滚时跳过）。
   */
  async snapshot(relPath: string, cwd: string): Promise<void> {
    if (this.taken.has(relPath)) {
      return; // 已快照，保留原始版本
    }
    this.taken.add(relPath);
    await this.ensureDir();

    const src = path.resolve(cwd, relPath);
    const dest = path.join(this.dir, encodeFilename(relPath));
    try {
      const content = await readFile(src);
      await writeFile(dest, content);
    } catch {
      // 文件不存在 → 记录为"新增文件"，回滚时删除
      await writeFile(`${dest}.new`, '');
    }
  }

  /**
   * 回滚：恢复所有已快照的文件。
   * 返回回滚结果摘要（成功/跳过/失败文件列表）。
   */
  async rollback(cwd: string): Promise<RollbackResult> {
    const result: RollbackResult = { restored: [], skipped: [], failed: [] };

    for (const relPath of this.taken) {
      const dest = path.resolve(cwd, relPath);
      const snap = path.join(this.dir, encodeFilename(relPath));
      try {
        // 检查是否为新增文件（snapshot 时不存在）
        try {
          await readFile(`${snap}.new`);
          // 新增文件 → 回滚时删除
          await rm(dest, { force: true });
          result.restored.push(relPath);
          continue;
        } catch {
          // 不是新增文件，继续恢复
        }

        const content = await readFile(snap);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, content);
        result.restored.push(relPath);
      } catch (error) {
        result.failed.push({
          path: relPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 清理快照目录
    await this.cleanup();

    return result;
  }

  /** 正常完成：清理快照目录。 */
  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  /** 已快照文件数。 */
  get count(): number {
    return this.taken.size;
  }
}

// ── 类型 ──

export interface RollbackResult {
  restored: string[];
  skipped: string[];
  failed: Array<{ path: string; error: string }>;
}

/** 将文件相对路径编码为合法文件名（路径分隔符 → __）。 */
function encodeFilename(relPath: string): string {
  return relPath.replace(/[/\\:]/g, '__');
}
