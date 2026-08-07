/**
 * 计划步骤与依赖关系类型定义。
 *
 * 用于 T2.1 依赖检测、T2.2 进度跟踪、T2.3 回滚。
 */

/** 单个计划步骤。 */
export interface PlanStep {
  /** 步骤序号（从 1 开始）。 */
  index: number;
  /** 步骤标题（从 markdown 列表提取）。 */
  title: string;
  /** 步骤描述全文。 */
  description: string;
  /** 显式声明的依赖步骤编号（depends on: 1, 3 格式）。 */
  declaredDeps: number[];
  /** 自动检测的文件路径引用。 */
  fileRefs: string[];
  /** 该步骤是否为文件写操作（编辑/创建/删除）。 */
  isWrite: boolean;
}

/** 步骤间的依赖关系边。 */
export interface StepDependency {
  /** 依赖方步骤编号（需要等待的步骤）。 */
  from: number;
  /** 被依赖方步骤编号（必须先完成的步骤）。 */
  to: number;
  /** 依赖原因（供调试与提示）。 */
  reason: string;
}

/** 依赖分析结果。 */
export interface DepsAnalysis {
  /** 所有步骤列表。 */
  steps: PlanStep[];
  /** 依赖关系列表。 */
  dependencies: StepDependency[];
  /** 拓扑排序后的执行顺序（步骤编号列表）。 */
  ordered: number[];
  /** 循环依赖检测结果（空数组 = 无循环）。 */
  cycles: number[][];
  /** 无依赖的并行组（每组内的步骤可并行执行）。 */
  parallelGroups: number[][];
}
