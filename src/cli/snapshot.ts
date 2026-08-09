/**
 * `lumen snapshot` 命令（v3.0 M3 / T3.6）。
 *
 * 管理多文件事务快照：
 * - `lumen snapshot` / `lumen snapshot list`：列出全部快照 taskId；
 * - `lumen snapshot clean`：清理全部过期/遗留快照（失败或取消后的残留）。
 *
 * 快照目录：<cwd>/.lumen/snapshots/<taskId>/（SnapshotManager 管理）。
 */

import { SnapshotManager } from '../orchestrator';

/** snapshot 命令选项。 */
export interface SnapshotCommandOptions {
  /** 工作目录。 */
  cwd: string;
  /** 子动作：list | clean（缺省 list）。 */
  action?: string;
}

/** 执行 snapshot 命令。 */
export async function runSnapshotCommand(options: SnapshotCommandOptions): Promise<void> {
  const manager = new SnapshotManager(options.cwd);
  const action = options.action ?? 'list';

  if (action === 'clean') {
    const cleaned = await manager.clean();
    if (cleaned.length === 0) {
      console.log('无遗留快照，无需清理。');
      return;
    }
    console.log(`已清理 ${cleaned.length} 个快照：`);
    for (const id of cleaned) {
      console.log(`  - ${id}`);
    }
    return;
  }

  // list（默认）
  const names = await manager.list();
  if (names.length === 0) {
    console.log('无快照。');
    return;
  }
  console.log(`共 ${names.length} 个快照：`);
  for (const id of names) {
    console.log(`  - ${id}`);
  }
}
