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

// ── 审查未完成（K16）────────────────────────────────────────

/**
 * 「这一维没审到」的原因代码。
 *
 * 为什么要分类而不只写「未完成」（v5.0 K16 用户要求）：用户看到「3/9 维未完成」时，
 * 下一步动作完全取决于原因——**401 要去检查 Key、超时要去加大超时、断网要恢复网络、
 * 余额耗尽要充值**。只写「未完成」等于把排查成本全丢回给用户。
 */
export type ReviewIncompleteReason =
  | 'unauthorized' // 401/403：Key 无效 / 过期 / 未授权
  | 'quota' // 402 / 余额不足：账户没钱了
  | 'network' // 连不上（DNS / 拒绝连接 / 断网 / 代理不通）
  | 'timeout' // 子代理超时或请求超时
  | 'parse-failed' // 模型回了，但不是可解析的 JSON
  | 'turn-limit' // 子代理达到轮数上限，结论不完整
  | 'error'; // 其他未归类错误

/** 一个「没审到」的子代理组（含它负责的维度）。 */
export interface ReviewIncomplete {
  /** 子代理组名。 */
  group: ReviewAgentGroup;
  /** 该组负责的维度（报告逐维标注用）。 */
  dimensions: ReviewDimension[];
  /** 原因代码（决定给用户什么建议）。 */
  reason: ReviewIncompleteReason;
  /** 原始原因摘要（含 HTTP 状态 / 超时毫秒 / 网络错误），用于具体排查。 */
  detail: string;
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
  /**
   * 「未运行」的具体原因（`testPassed === null` 时才有意义）。
   *
   * K7（v5.0 T23.3 实测）：项目没有 `verify` 脚本时，旧实现跑 `npm run verify` 得到
   * Missing script → 被判成「❌ 失败」，读起来像「你的测试挂了」。现在**先看 package.json**，
   * 没有脚本就压根不跑，并标成 `no-verify-script`（报告显示「未运行（项目未定义 verify 脚本）」）。
   */
  testNotRunReason?: 'no-verify-script';
  /**
   * 未完成的子代理组（K16）。
   *
   * 空 / 缺省 = 9 维全部审到；非空 = **本次审查不完整**，调用方必须给 `exit 1`，
   * 报告也不许写「未发现明显问题」。这是「判不了绝不冒充通过」红线的执行点。
   */
  incomplete?: ReviewIncomplete[];
  /** 审查严重程度阈值（v3.1 M5 / T5.4；可选，缺省 normal）。 */
  severity?: ReviewSeverity;
  /** 发现的问题列表。 */
  issues: ReviewIssue[];
  /** 维度汇总。 */
  summary: Record<ReviewDimension, { critical: number; medium: number; suggestion: number }>;
  /** 审查耗时（毫秒）。 */
  durationMs: number;
  /** autoFix 修复结果（v4.0 M1 T1.4：/review --fix 后附加，格式化为「修复结果」区块）。 */
  fixResult?: {
    fixed: number;
    manual: number;
    rolledBack: number;
    items: Array<{
      issue: ReviewIssue;
      category: 'A' | 'B';
      status: 'fixed' | 'manual' | 'rolledback';
      diff?: string;
      reason?: string;
    }>;
  };
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

/**
 * 审查子代理名（`SubagentDef.name`）的统一前缀。
 *
 * `createReviewAgents` 造出的 5 个名字都长这样：`review-architecture-style`，
 * 而 `AGENT_DIMENSIONS` 的键是**去掉前缀**的分组名（`architecture-style`）。
 */
export const REVIEW_AGENT_PREFIX = 'review-';

/** 分组名的合法取值（从 AGENT_DIMENSIONS 的键派生，不另写一份清单）。 */
const AGENT_GROUP_NAMES = Object.keys(AGENT_DIMENSIONS) as ReviewAgentGroup[];

/**
 * 子代理名 → 审查分组。**取不到就返回 `undefined`，绝不猜**。
 *
 * ## 为什么要这个函数（v5.0 K16 线上崩溃的根因）
 *
 * 修 K16 时把「子代理失败计入未完成」写进了 `engine.ts`，取维度用的是：
 *
 * ```ts
 * const group = def.name as ReviewAgentGroup;   // ❌ 'review-architecture-style'
 * const dimensions = AGENT_DIMENSIONS[group];   // ❌ undefined（键是 'architecture-style'）
 * ```
 *
 * `as` 把「名字 ≠ 键」这个事实盖掉了：`undefined` 一路流进 `ReviewIncomplete.dimensions`，
 * 直到 `incompleteCount()` 里 `item.dimensions.length` 才炸，**5 个组全中**。
 * 结果：只要有一条审查子代理失败（401 / 断网 / 超时），`review` 就打 `TypeError` 崩掉，
 * 而不是告诉用户「几维没审到、为什么」——恰恰是 K16 要修的那个场景修不成。
 *
 * 教训：**跨命名的映射必须是函数 + 校验，禁止 `as` 硬转**。`as` 只改类型不改值，
 * 它把「编译期能查出来的错」变成了「运行期才炸的 undefined」。
 */
export function reviewGroupOfAgentName(name: string): ReviewAgentGroup | undefined {
  if (!name.startsWith(REVIEW_AGENT_PREFIX)) {
    return undefined;
  }
  const candidate = name.slice(REVIEW_AGENT_PREFIX.length);
  return AGENT_GROUP_NAMES.find((group) => group === candidate);
}

// ── 审查配置 ────────────────────────────────────────────────

/**
 * 显式上下文代码工件（v3.0 I2 修复：Reviewer 可见上下文中的代码工件）。
 *
 * 结构兼容 orchestrator.Artifact 的 code/file 子集。定义在 reviewer 模块内部
 * 而非引入 orchestrator，保持依赖方向单向（orchestrator → agents → reviewer，
 * reviewer 不反向依赖 orchestrator）。
 */
export interface ReviewContextArtifact {
  /** 工件类型（code=代码 / file=通用文件）。 */
  type: 'code' | 'file';
  /** 关联文件路径（可选，虚拟工件可无路径）。 */
  path?: string;
  /** 工件内容（文本）。 */
  content: string;
}

/** RA 可选配置。 */
export interface ReviewOptions {
  /** 审查模式。 */
  scope: ReviewScope;
  /** 显式上下文代码工件（v3.0：审查子代理直接阅读 Coder 产出，优先于磁盘文件）。 */
  contextArtifacts?: ReviewContextArtifact[];
  /** 是否自动修正 🟢 suggestion 级别问题。 */
  autoFix?: boolean;
  /** 审查严重程度阈值（v3.1 M5 / T5.4：strict / normal / lenient，缺省 normal）。 */
  severity?: ReviewSeverity;
  /** 各审查子代理超时（默认 60s）。 */
  agentTimeoutMs?: number;
  /** 各审查子代理最大轮数（默认 5）。 */
  agentMaxTurns?: number;
}

// ── 对抗性闭环扩展（v3.0 M3 / T3.3）──────────────────────────

/** 审查动作：approve 进入 QA / reject 打回 Coder 修复（T3.3）。 */
export type ReviewAction = 'approve' | 'reject';

/** 审查严重程度阈值（v3.1 M5 / T5.4，/review --severity）。 */
export type ReviewSeverity = 'strict' | 'normal' | 'lenient';

/** 合法 severity 值列表（供非法值报错提示）。 */
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ['strict', 'normal', 'lenient'];

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
 * 审查是否完整（K16）：只要有一个子代理组没审到，就算**不完整**。
 *
 * 调用方（CLI 退出码 / TUI 结论文案 / 对抗性闭环 action）统一用它判断，
 * 避免「一处认为审过了、另一处认为没审」的分叉。
 */
export function isReviewIncomplete(report: ReviewReport): boolean {
  return (report.incomplete?.length ?? 0) > 0;
}

/**
 * 判定审查动作（T3.3 对抗性闭环 + v3.1 M5 / T5.4 severity 阈值）。
 *
 * severity 三档（缺省 normal 保持 v3.0 语义）：
 * - strict：🔴 critical 或 🟡 medium → 必 reject（medium 无条件阻断）；
 * - normal：🔴 critical → 必 reject；🟡 medium → 结合自动测试（testPassed=false 时 reject，
 *   即「medium 可 reject」）；仅 🟢 / 无问题 → approve；
 * - lenient：仅 🔴 critical → reject；🟡 medium 不阻断。
 *
 * **审查不完整一律 reject**（K16）：`approve` 的含义是「我看过了，可以进」——
 * 有维度没审到还敢 approve，就是把「没看」说成「没问题」。
 */
export function determineReviewAction(
  issues: ReviewIssue[],
  options: { severity?: ReviewSeverity; testPassed?: boolean | null; incomplete?: boolean } = {},
): ReviewAction {
  // K16：先判「审完没」——再谈严重程度。三档 severity 都不豁免这一条。
  if (options.incomplete === true) {
    return 'reject';
  }
  const severity = options.severity ?? 'normal';
  const hasCritical = issues.some((i) => i.severity === 'critical');
  const hasMedium = issues.some((i) => i.severity === 'medium');

  if (severity === 'lenient') {
    return hasCritical ? 'reject' : 'approve';
  }
  if (severity === 'strict') {
    return hasCritical || hasMedium ? 'reject' : 'approve';
  }
  // normal：critical 必拒；medium 在 QA 失败时拒（可拒），否则不阻断
  if (hasCritical) {
    return 'reject';
  }
  if (hasMedium && options.testPassed === false) {
    return 'reject';
  }
  return 'approve';
}

/** 从 v2.1 ReviewReport 构建对抗性闭环 ReviewResult（判定 action + 生成中文摘要）。 */ export function buildReviewResult(
  report: ReviewReport,
  severity?: ReviewSeverity,
): ReviewResult {
  const incomplete = isReviewIncomplete(report);
  const action = determineReviewAction(report.issues, {
    severity,
    testPassed: report.testPassed,
    incomplete,
  });
  const critical = report.issues.filter((i) => i.severity === 'critical').length;
  const medium = report.issues.filter((i) => i.severity === 'medium').length;
  const suggestion = report.issues.filter((i) => i.severity === 'suggestion').length;
  const actionText = action === 'reject' ? '打回 Coder 修复' : '通过，进入 QA';
  const testText = report.testPassed === null ? '未运行' : report.testPassed ? '通过' : '失败';
  // K16：不完整时摘要必须点明「没审完」，不能被「🔴×0 🟡×0」读成「很干净」
  const incompleteText =
    incomplete === true ? `**审查未完成 ${incompleteCount(report)}/9 维**；` : '';
  const summary = `审查发现 🔴×${critical} 🟡×${medium} 🟢×${suggestion}；${incompleteText}自动测试${testText}；动作：${actionText}`;
  return { action, issues: report.issues, summary, testPassed: report.testPassed, report };
}

/** 已审到的维度数（9 - 未完成的维度数）。 */
export function reviewedDimensionCount(report: ReviewReport): number {
  return ALL_DIMENSIONS.length - incompleteCount(report);
}

/**
 * 未审到的维度数（一个子代理组可能覆盖 2 个维度，故按**维度**计）。
 *
 * `Array.isArray` 守卫不是多余的：**这里就是 K16 那次线上崩溃的爆点**
 * （`dimensions` 曾经因为 `as` 硬转而是 `undefined`，`item.dimensions.length` 直接抛
 * `Cannot read properties of undefined`，把「报告说清几维没审到」变成了 `TypeError`）。
 * 类型上现在由 `reviewGroupOfAgentName` 保证不会发生，但这条守卫的语义是：
 * **宁可少算一个维度，也不许整条 `review` 命令崩掉**——报告少一行是可修的，
 * 崩掉会让用户拿不到任何「哪几维没审」的信息，比假绿更难排查。
 */
export function incompleteCount(report: ReviewReport): number {
  return (report.incomplete ?? []).reduce(
    (sum, item) => sum + (Array.isArray(item.dimensions) ? item.dimensions.length : 0),
    0,
  );
}
