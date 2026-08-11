# [2026-08-11] team 快照保护失效：Agent 写盘绕过快照登记

## 问题描述
- 现象：手工测试 `concertoai team "<任务>"`（真实 CoderAgent 写盘）闭环超限触发回滚时，**快照保护形同虚设**：已写文件未被恢复（rollback 报「文件被外部修改（无任务写入登记），拒绝覆盖」）、拆解清单外的新增文件直接残留。
- 环境：Windows x64；真实 CoderAgent + DiskFileWriter 装配路径

## 根因分析
- 直接原因：`src/cli/team.ts` 装配 `new DiskFileWriter(options.cwd)` 写盘时**从未调用 `SnapshotManager.recordWrite`**；且 `begin(taskId, files)` 只快照拆解出的第一个 coder 任务的 `files`（通常为空/不全）。rollback 时：① 快照存在的文件被 Agent 修改但无写入登记 → 判「外部修改」拒绝覆盖 → 回滚失败；② 拆解清单外的文件根本没快照 → 无法恢复 → 残留。
- 深层原因：`SnapshotManager` 的事务模型假设「任务开始前能枚举全部涉及文件」（begin 预登记），但 team 场景 Agent 实际写盘路径由模型决定、**运行时才可知**；`recordWrite` 只是「登记已存在的快照文件」，缺少「文件首次写入时动态快照」的接入点——两者叠加导致写盘与快照脱节。

## 解决方案
- 修复方式：
  1. `SnapshotManager` 新增 `registerWrite(taskId, relPath, content)`（写前调用）：文件未在快照清单 → 先动态快照（存在→保存原内容；不存在→标记新增），再记录写入；rollback 据此恢复**任意**被任务写入的文件。
  2. `src/cli/team.ts` 用事务感知 writer 包装 DiskFileWriter：`write` 前先 `snapshots.registerWrite(taskId, relPath, content)` 再写盘；事务上下文（snapshots/taskId）提前到 coder 装配前创建。
- 涉及文件：`src/orchestrator/transaction.ts`（registerWrite）、`src/cli/team.ts`（txnWriter + agents.coder 类型改为可选）、`tests/orchestrator/transaction.test.ts`（4 用例）、`tests/e2e/team-cli.test.ts`（真实 CoderAgent 写盘回滚 E2E：预登记文件恢复 + 动态登记新增文件删除）

## 经验教训
- 如何避免同类问题：事务/快照模块必须提供**运行时动态登记**接入点（不能只靠 begin 预登记枚举）；「写盘前登记」应作为 writer 的强制契约（生产 writer 包装器），而非依赖调用方自觉；对「Agent 实际写盘路径未知」的编排场景，回滚保护必须覆盖清单外文件。
- 是否需要更新规范：✅
- 规范更新位置：`ARCHITECTURE.md`（SnapshotManager 能力表补充 registerWrite；team 装配说明事务 writer）

## 相关链接
- 对话记录：v3.2 手工测试 T6.5 修复
- 相关 PR/Commit：（本次提交）
