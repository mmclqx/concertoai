/**
 * self-heal 公共类型（v3.2 M2 / T2.1 拆分）。
 *
 * 独立 types.ts 避免 classifier / repair / snapshot-guard 三模块循环依赖：
 * - RepairVerifyOptions 引用 classifier 的 VerifyReport 与 SnapshotManager / ApprovalRequest；
 * - SelfHealAttempt / RepairVerifyResult 由 repair 与 snapshot-guard 共同消费。
 */

import type { ModelClient } from '../../model/client';
import type { SnapshotManager } from '../../orchestrator/transaction';
import type { ApprovalRequest } from '../../tools/registry';
import type { VerifyError, VerifyReport } from './classifier';

/** 变更行数统计（SEARCH/REPLACE 行数近似 diff stat）。 */
export interface DiffLineStat {
  /** 新增行数。 */
  added: number;
  /** 删除行数。 */
  removed: number;
}

/** 模型生成的修复方案（search/replace 唯一匹配，经 planEdit 校验）。 */
export interface ModelFixPlan {
  /** 相对 cwd 的文件路径。 */
  file: string;
  /** 唯一匹配块（SEARCH）。 */
  search: string;
  /** 替换内容（REPLACE）。 */
  replace: string;
  /** 统一 diff（供审批框展示）。 */
  diff: string;
  /** 修复后的完整内容。 */
  newContent: string;
}

/** 单个错误的修复动作（lint 直修 / 模型修复 / 跳过）。 */
export type SelfHealAction = 'lint-fix' | 'model-fix' | 'none';

/** 单次尝试结果。 */
export interface SelfHealAttempt {
  /** 尝试序号（1-based）。 */
  attempt: number;
  /** 本次执行的修复动作。 */
  action: SelfHealAction;
  /** 本次修复后的 verify 报告。 */
  report: VerifyReport;
  /** 模型修复应用的文件 diff（action=model-fix 时非空）。 */
  appliedFixes: Array<{ file: string; diff: string }>;
  /** 结构化反馈（未自动修的错误：code + suggestion）。 */
  feedback: Array<{ code?: string; suggestion: string }>;
  /** 模型修复是否被回滚（T1.3：修复后 verify 失败或引入新错误 → rollback 恢复原状）。 */
  rolledBack?: boolean;
  /** 回滚原因 / 回滚失败详情（rolledBack=true 或回滚失败时）。 */
  rollbackReason?: string;
}

/** 修复执行器选项。 */
export interface RepairVerifyOptions {
  /** 工作目录（沙箱根）。 */
  cwd: string;
  /** 执行 verify（返回原始输出；测试注入 fake）。 */
  runVerify: () => Promise<{ stdout: string; stderr: string }>;
  /** 执行 `npm run lint:fix`（返回是否成功；生产走 shell 白名单免审批，测试注入 fake）。 */
  runLintFix: () => Promise<{ ok: boolean }>;
  /** 增量 verify（T2.3）：lint 修复后仅 rerun lint 段（快速），通过则合并 lint 段结果跳过全量。 */
  runLintOnly?: () => Promise<{ stdout: string; stderr: string }>;
  /** 模型客户端（type 简单错误修复；未提供则跳过模型修复）。 */
  client?: ModelClient;
  /** 模型 ID（client 存在时必须）。 */
  model?: string;
  /** 审批回调（模型修复前逐项确认，fail-closed；缺省拒绝）。 */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  /** 快照管理器（T1.3）：模型修复落盘前登记快照，失败/引入新错误自动回滚；缺省不启用快照保护。 */
  snapshots?: SnapshotManager;
  /** 快照 taskId 前缀（默认 `self-heal`，快照目录 `.concertoai/snapshots/<prefix>-<ts>/`）。 */
  snapshotPrefix?: string;
  /** 日志输出。 */
  log?: (message: string) => void;
}

/** 修复执行结果。 */
export interface RepairVerifyResult {
  /** 最终是否全部通过。 */
  passed: boolean;
  /** 最终 verify 报告。 */
  report: VerifyReport;
  /** 每次尝试记录。 */
  attempts: SelfHealAttempt[];
  /** 是否超限转人工（失败且尝试次数达到上限）。 */
  exceeded: boolean;
  /** 快照保护失效警告（T2.4）：任一次模型修复快照登记失败 → true（报告/CLI 展示）。 */
  snapshotWarning?: boolean;
}

/** applyModelFix 返回：单次模型修复的完整结果（含快照状态）。 */
export interface ApplyModelFixResult {
  /** 本次尝试记录（含 action=model-fix / none 与回滚状态）。 */
  attempt: SelfHealAttempt;
  /** 快照登记是否失败（快照保护未生效，T2.4）。 */
  snapshotWarning: boolean;
}

/** 模型修复输出（解析后的 file/search/replace）。 */
export interface ModelFixPlanInput {
  file: string;
  search: string;
  replace: string;
}

/** 引用导出（供 repair/snapshot-guard/index 便捷 re-export）。 */
export type { VerifyError, VerifyReport };
