/**
 * self-heal 模块 barrel（v3.2 M2 / T2.1 拆分）。
 *
 * 原 `src/loop/self-heal.ts`（870 行）拆分为：
 * - classifier.ts      四段分类器 + parseVerifyReport + mergeLintPassed（293 行）
 * - model.ts           模型修复计划生成（isSimpleTypeError / parseModelFixOutput / generateModelFixPlan）
 * - snapshot-guard.ts  快照守卫 applyModelFix（审批 → 快照 → 写盘 → 判定 → 回滚/提交）
 * - repair.ts          修复执行器 repairVerifyReport + 增量 verify + 常量
 * - types.ts           公共类型（避免循环依赖）
 * - index.ts           barrel + runSelfHeal 入口 + 生产辅助（本文件）
 *
 * 公共 API 与拆分前完全一致（纯结构迁移）：runSelfHeal / parseVerifyReport /
 * repairVerifyReport / generateModelFixPlan / parseModelFixOutput / isSimpleTypeError /
 * diffLineStat / suggestionFor / runVerifyAndParse / runVerifyCommand / runLintFixCommand /
 * MAX_SELF_HEAL_ATTEMPTS / MAX_MODEL_FIXES_PER_ATTEMPT / 类型（VerifyStage / VerifyError /
 * VerifyReport / RepairVerifyOptions / RepairVerifyResult / SelfHealAttempt / SelfHealAction /
 * ModelFixPlan / DiffLineStat / RunSelfHealOptions 等）。
 */

import { ChildProcessQaRunner, DEFAULT_VERIFY_TIMEOUT_MS } from '../../agents/qa';
import type { ModelClient } from '../../model/client';
import { SnapshotManager } from '../../orchestrator/transaction';
import type { ApprovalRequest } from '../../tools/registry';
import { shellTool } from '../../tools/shell';
import { parseVerifyReport } from './classifier';
import {
  diffLineStat,
  generateModelFixPlan,
  isSimpleTypeError,
  parseModelFixOutput,
  suggestionFor,
} from './model';
import {
  MAX_MODEL_FIXES_PER_ATTEMPT,
  MAX_SELF_HEAL_ATTEMPTS,
  repairVerifyReport,
  runVerifyAndParse,
  strategyFor,
} from './repair';
import type { RepairVerifyResult, SelfHealPhase } from './types';

// ── 生产辅助：真实执行 npm run verify / npm run lint:fix ───────

/**
 * 生产 verify 执行器：spawn `npm run verify`（复用 ChildProcessQaRunner），
 * 返回原始输出供 parseVerifyReport 解析。
 */
export async function runVerifyCommand(
  cwd: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  const runner = new ChildProcessQaRunner({ cwd });
  const result = await runner.run(timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS);
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * 生产 lint:fix 执行器：走 shell 工具 + 白名单 `npm run lint:fix` 免审批直跑。
 * 返回是否成功（退出码 0）。
 */
export async function runLintFixCommand(cwd: string): Promise<{ ok: boolean }> {
  const result = await shellTool.execute(
    { command: 'npm run lint:fix' },
    { cwd, allowlistedPrefixes: ['npm run lint:fix'] },
  );
  return { ok: result.ok };
}

/** runSelfHeal 选项。 */
export interface RunSelfHealOptions {
  /** 工作目录（沙箱根）。 */
  cwd: string;
  /** 模型客户端（type 简单错误修复；未提供则仅 lint 直修 + 结构化反馈）。 */
  client?: ModelClient;
  /** 模型 ID（client 存在时必须）。 */
  model?: string;
  /** 审批回调（模型修复前逐项确认，fail-closed；缺省拒绝）。 */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean> | boolean;
  /** 日志输出。 */
  log?: (message: string) => void;
  /** 测试注入：执行 verify（缺省跑真实 `npm run verify`）。 */
  runVerify?: () => Promise<{ stdout: string; stderr: string }>;
  /** 测试注入：执行 lint:fix（缺省走 shell 白名单 `npm run lint:fix`）。 */
  runLintFix?: () => Promise<{ ok: boolean }>;
  /** 测试注入：增量 lint 段（T2.3，缺省不启用增量 verify）。 */
  runLintOnly?: () => Promise<{ stdout: string; stderr: string }>;
  /** 阶段回调（v3.2 M4 / T4.2）：verify/lint-fix/model-fix/verify-fix/rollback/done。 */
  onPhase?: (phase: SelfHealPhase) => void;
}

/**
 * 触发入口主流程（T1.4）：执行 `npm run verify` → 通过则直接返回；
 * 失败则自动走 M1 闭环（分类 → 修复 → 验证 → 回滚），全程启用快照保护。
 *
 * 供两入口共用：
 * - chat 内 `/self-heal` 斜杠命令（App.tsx 拦截 → executeSelfHealCommand）；
 * - `concertoai self-heal` CLI（非交互，src/cli/self-heal.ts）。
 */
export async function runSelfHeal(options: RunSelfHealOptions): Promise<RepairVerifyResult> {
  const log = options.log ?? (() => {});
  const onPhase = options.onPhase ?? (() => {});
  // 测试注入优先；缺省走生产实现（spawn npm run verify / shell 白名单 lint:fix）
  const runVerify =
    options.runVerify ??
    ((): Promise<{ stdout: string; stderr: string }> => runVerifyCommand(options.cwd));
  const runLintFix =
    options.runLintFix ?? ((): Promise<{ ok: boolean }> => runLintFixCommand(options.cwd));

  log('[self-heal] 执行 npm run verify …');
  // T4.2：初始 verify 阶段
  onPhase('verify');
  const initial = await runVerifyAndParse({ cwd: options.cwd, runVerify, runLintFix, log });
  if (initial.passed) {
    onPhase('done');
    log(initial.summary);
    return { passed: true, report: initial, attempts: [], exceeded: false };
  }

  log(`[self-heal] ${initial.summary}`);
  const snapshots = new SnapshotManager(options.cwd);
  const result = await repairVerifyReport(initial, {
    cwd: options.cwd,
    runVerify,
    runLintFix,
    runLintOnly: options.runLintOnly,
    client: options.client,
    model: options.model,
    requestApproval: options.requestApproval,
    snapshots,
    onPhase,
    log,
  });
  return result;
}

// ── re-export（保持公共 API 与拆分前一致）─────────────────────

export type { VerifyError, VerifyReport, VerifyStage } from './classifier';
export type {
  DiffLineStat,
  ModelFixPlan,
  ModelFixPlanInput,
  RepairVerifyOptions,
  RepairVerifyResult,
  SelfHealAction,
  SelfHealAttempt,
  SelfHealPhase,
} from './types';
export {
  diffLineStat,
  generateModelFixPlan,
  isSimpleTypeError,
  MAX_MODEL_FIXES_PER_ATTEMPT,
  MAX_SELF_HEAL_ATTEMPTS,
  parseModelFixOutput,
  parseVerifyReport,
  repairVerifyReport,
  runVerifyAndParse,
  strategyFor,
  suggestionFor,
};
