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
