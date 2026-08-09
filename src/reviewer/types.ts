/**
 * Reviewer Agent 类型定义（v2.1 M5）。
 *
 * RA 是一个独立运行的代码评审智能体，拥有自己的知识库、决策树和工具链。
 */

// ── 审查维度 ────────────────────────────────────────────────

/** 9 大审查维度。 */
export type ReviewDimension =
  | 'architecture' // 架构一致性
  | 'style' // 代码风格
  | 'types' // 类型安全
  | 'errors' // 错误处理
  | 'tests' // 测试覆盖
  | 'security' // 安全审查
  | 'performance' // 性能审查
  | 'maintainability' // 可维护性
  | 'docs'; // 文档同步

/** 所有审查维度列表。 */
export const ALL_DIMENSIONS: ReviewDimension[] = [
  'architecture',
  'style',
  'types',
  'errors',
  'tests',
  'security',
  'performance',
  'maintainability',
  'docs',
];

// ── 严重程度 ────────────────────────────────────────────────

/** 问题严重程度。 */
export type Severity = 'critical' | 'medium' | 'suggestion';

/** 严重程度 → 显示符号。 */
export const SEVERITY_ICON: Record<Severity, string> = {
  critical: '🔴',
  medium: '🟡',
  suggestion: '🟢',
};

// ── 审查问题 ────────────────────────────────────────────────

/** 单个审查问题。 */
export interface ReviewIssue {
  /** 所属维度。 */
  dimension: ReviewDimension;
  /** 严重程度。 */
  severity: Severity;
  /** 文件路径。 */
  file: string;
  /** 行号（可选）。 */
  line?: number;
  /** 问题标题。 */
  title: string;
  /** 问题详细描述。 */
  description: string;
  /** 修复建议（可包含 diff）。 */
  suggestion?: string;
}

// ── 审查报告 ────────────────────────────────────────────────

/** 审查范围类型。 */
export type ReviewScope =
  | { type: 'files'; paths: string[] }
  | { type: 'auto' }
  | { type: 'pr'; diff: string };

/** 完整审查报告。 */
export interface ReviewReport {
  /** 审查范围描述。 */
  scope: string;
  /** 审查时间 ISO。 */
  timestamp: string;
  /** 自动测试是否通过（null = 未运行）。 */
  testPassed: boolean | null;
  /** 发现的问题列表。 */
  issues: ReviewIssue[];
  /** 维度汇总。 */
  summary: Record<ReviewDimension, { critical: number; medium: number; suggestion: number }>;
  /** 审查耗时（毫秒）。 */
  durationMs: number;
}

// ── 审查子代理分组 ──────────────────────────────────────────

/** 5 个审查子代理（9 维聚合）。 */
export type ReviewAgentGroup =
  | 'architecture-style'
  | 'types-errors'
  | 'tests-docs'
  | 'security'
  | 'performance-maintainability';

/** 每个审查子代理负责的维度。 */
export const AGENT_DIMENSIONS: Record<ReviewAgentGroup, ReviewDimension[]> = {
  'architecture-style': ['architecture', 'style'],
  'types-errors': ['types', 'errors'],
  'tests-docs': ['tests', 'docs'],
  security: ['security'],
  'performance-maintainability': ['performance', 'maintainability'],
};

// ── 审查配置 ────────────────────────────────────────────────

/** RA 可选配置。 */
export interface ReviewOptions {
  /** 审查模式。 */
  scope: ReviewScope;
  /** 是否自动修正 🟢 suggestion 级别问题。 */
  autoFix?: boolean;
  /** 各审查子代理超时（默认 60s）。 */
  agentTimeoutMs?: number;
  /** 各审查子代理最大轮数（默认 5）。 */
  agentMaxTurns?: number;
}

// ── 对抗性闭环扩展（v3.0 M3 / T3.3）──────────────────────────

/** 审查动作：approve 进入 QA / reject 打回 Coder 修复（T3.3）。 */
export type ReviewAction = 'approve' | 'reject';

/** 对抗性闭环审查结果（T3.3 结构化输出，供 T3.5 闭环消费）。 */
export interface ReviewResult {
  /** 审查动作：approve（进入 QA）/ reject（打回 Coder 修复）。 */
  action: ReviewAction;
  /** 问题列表（🔴🟡🟢，按严重程度排序）。 */
  issues: ReviewIssue[];
  /** 结果摘要（中文，含计数与动作说明）。 */
  summary: string;
  /** 自动测试是否通过（null = 未运行）。 */
  testPassed: boolean | null;
  /** 关联的完整审查报告（保留 v2.1 维度汇总/耗时，供可观测性）。 */
  report?: ReviewReport;
}

/**
 * 判定审查动作（T3.3 对抗性闭环）：
 * - 🔴 critical 问题存在 → 必 reject（打回 Coder 修复）；
 * - 🟡 medium 问题存在 → 可 reject（打回 Coder 修复）；
 * - 仅 🟢 suggestion 或无问题 → approve（不阻断，进入 QA）。
 */
export function determineReviewAction(issues: ReviewIssue[]): ReviewAction {
  if (issues.some((i) => i.severity === 'critical' || i.severity === 'medium')) {
    return 'reject';
  }
  return 'approve';
}

/** 从 v2.1 ReviewReport 构建对抗性闭环 ReviewResult（判定 action + 生成中文摘要）。 */
export function buildReviewResult(report: ReviewReport): ReviewResult {
  const action = determineReviewAction(report.issues);
  const critical = report.issues.filter((i) => i.severity === 'critical').length;
  const medium = report.issues.filter((i) => i.severity === 'medium').length;
  const suggestion = report.issues.filter((i) => i.severity === 'suggestion').length;
  const actionText = action === 'reject' ? '打回 Coder 修复' : '通过，进入 QA';
  const testText = report.testPassed === null ? '未运行' : report.testPassed ? '通过' : '失败';
  const summary = `审查发现 🔴×${critical} 🟡×${medium} 🟢×${suggestion}；自动测试${testText}；动作：${actionText}`;
  return { action, issues: report.issues, summary, testPassed: report.testPassed, report };
}
