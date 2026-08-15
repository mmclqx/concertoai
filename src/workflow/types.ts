/**
 * 工作流类型定义（v4.0 M2 T2.1）。
 *
 * 结构：Workflow = name + description + steps[]（DAG）。
 * 每个 step 是一个 shell 命令，可声明 depends（依赖）、retry（重试）、
 * require: approval（审批节点）、files（事务快照跟踪文件，供失败回滚）。
 */

// ── 工作流定义 ──────────────────────────────────────────────

/** 步骤执行要求：none = 直接执行；approval = 执行前需用户审批（审批节点）。 */
export type StepRequirement = 'none' | 'approval';

/** 单个工作流步骤。 */
export interface WorkflowStep {
  /** 步骤名（DAG 节点 ID，须在 workflow 内唯一）。 */
  name: string;
  /** 要执行的 shell 命令。 */
  run: string;
  /** 依赖步骤名列表（必须先成功完成）。 */
  depends?: string[];
  /**
   * 失败恢复重试上限（v4.1 T1.3 语义重定义）：用户在 R/S/F/A 恢复流程中重试该
   * 步骤的次数上限。缺省 = 不限制（用户主动 R/F 可任意重试）；retry: N = 最多
   * 恢复 N 次，第 N+1 次失败后强制 abort（整体回滚）；retry: 0 = 不允许重试
   * （首次失败即转 abort）。注意：不再是调度器内部自动重试（已归零，见 executor）。
   */
  retry?: number;
  /** 审批要求（默认 none）。 */
  require?: StepRequirement;
  /** 该步骤修改的文件（项目相对路径，事务回滚跟踪用，可选）。 */
  files?: string[];
  /** 步骤说明（展示用，可选）。 */
  description?: string;
}

/** 完整工作流定义。 */
export interface Workflow {
  /** 工作流名（唯一，`concertoai workflow run <name>` 定位）。 */
  name: string;
  /** 用途说明（可选）。 */
  description?: string;
  /** 步骤列表（按声明顺序；执行顺序由 DAG 依赖决定）。 */
  steps: WorkflowStep[];
  /** 格式版本（当前 1，可选）。 */
  version?: number;
}

// ── 执行状态与进度 ──────────────────────────────────────────

/** 步骤运行状态。 */
export type StepRunState =
  | 'pending'
  | 'running'
  | 'waiting-approval'
  | 'done'
  | 'failed'
  | 'skipped';

/** 工作流整体运行状态。 */
export type WorkflowRunState = 'running' | 'done' | 'failed';

/** 单步进度事件（onProgress 推送，长任务可感知）。 */
export interface WorkflowProgress {
  /** 已推进的步骤数（done 计数，不区分跳过的可视化由调用方决定）。 */
  done: number;
  /** 步骤总数。 */
  total: number;
  /** 当前执行步骤名。 */
  stepName: string;
  /** 当前步骤状态。 */
  state: StepRunState;
}

// ── 执行结果 ────────────────────────────────────────────────

/** 单步执行结果。 */
export interface WorkflowStepResult {
  /** 步骤名。 */
  name: string;
  /** 状态。 */
  state: StepRunState;
  /** 失败原因（failed 时）。 */
  error?: string;
  /** 输出摘要（可选，stdout 尾部）。 */
  output?: string;
}

/** 工作流执行结果。 */
export interface WorkflowRunResult {
  /** 是否全部成功。 */
  ok: boolean;
  /** 最终状态。 */
  state: WorkflowRunState;
  /** 执行顺序（拓扑序）。 */
  order: string[];
  /** 每步结果（按拓扑序）。 */
  steps: WorkflowStepResult[];
  /** 失败步骤名（failed 时）。 */
  failedStep?: string;
  /** 被跳过步骤名列表。 */
  skipped: string[];
}

// ── 依赖推断（T2.4）────────────────────────────────────────

/** 自动推断出的依赖边（提示用户确认，不静默写入）。 */
export interface InferredDependency {
  /** 依赖方（test 依赖 build）。 */
  from: string;
  /** 被依赖方。 */
  to: string;
  /** 推断理由（如「test 通常需要先 build」）。 */
  reason: string;
}
