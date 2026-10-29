/**
 * 9 维审查子代理定义（v2.1 M5）。
 *
 * 9 个审查维度聚合为 5 个子代理并行执行。
 * 每个子代理拥有专属 system prompt 和输出格式要求。
 */

import type { SubagentDef } from '../agent/types';
import type {
  ReviewAgentGroup,
  ReviewDimension,
  ReviewIncompleteReason,
  ReviewIssue,
  Severity,
} from './types';

/** 维度 → 严重程度倾向映射。 */
const DIMENSION_SEVERITY: Record<ReviewDimension, Severity> = {
  architecture: 'critical',
  style: 'suggestion',
  types: 'critical',
  errors: 'critical',
  tests: 'medium',
  security: 'critical',
  performance: 'medium',
  maintainability: 'medium',
  docs: 'suggestion',
};

/** 审查子代理默认配置。 */
const BASE_CONFIG: Pick<SubagentDef, 'allowedTools' | 'maxTurns' | 'timeoutMs' | 'maxRepairs'> = {
  allowedTools: ['read_file', 'search_content', 'list_directory'],
  maxTurns: 5,
  timeoutMs: 60_000,
  maxRepairs: 1,
};

/** 输出格式指令（所有审查子代理共用）。 */
function outputFormat(dimensions: ReviewDimension[]): string {
  const dimNames = dimensions.join('、');
  return `
## 输出格式
以 JSON 数组格式输出，每个问题一个对象：
\`\`\`json
[
  {
    "dimension": "${dimensions[0]}",
    "severity": "critical|medium|suggestion",
    "file": "相对文件路径",
    "line": 行号或null,
    "title": "问题标题",
    "description": "详细描述",
    "suggestion": "修复建议（可选）"
  }
]
\`\`\`

无问题时返回空数组 \`[]\`。
仅输出 JSON，不要其他文字。
审查维度：${dimNames}。
默认严重程度倾向：${dimensions.map((d) => `${d}=${DIMENSION_SEVERITY[d]}`).join('，')}。
`;
}

/** 构建单个审查子代理的 system prompt。 */
function buildSystemPrompt(
  _group: ReviewAgentGroup,
  dimensions: ReviewDimension[],
  knowledgeCtx: string,
): string {
  const dimDesc: Record<ReviewDimension, string> = {
    architecture: '是否遵循项目分层？是否破坏现有抽象？新代码是否放在正确的模块？',
    style: '命名是否清晰？注释是否必要且准确？（Biome 已处理格式化，关注语义层）',
    types: '是否有 any 滥用？是否有不合理的类型断言？是否缺少 null 检查？',
    errors: 'try-catch 是否正确？错误是否被静默吞掉？用户可见的错误信息是否清晰？',
    tests: '新增/修改代码是否有对应测试？边界条件是否覆盖？mock 是否合理？',
    security: '路径注入？命令注入？敏感信息泄露？权限校验是否完整？',
    performance: '不必要的循环？同步阻塞？大文件读取？内存泄漏风险？',
    maintainability: '函数是否过长？职责是否单一？是否有重复代码？是否有硬编码魔法数字？',
    docs: '新增/修改的公开 API 是否更新了文档？README/架构文档是否需要同步？',
  };

  const checks = dimensions.map((d) => `- **${d}**: ${dimDesc[d]}`).join('\n');

  return `你是 ConcertoAI Reviewer Agent 的一个审查子代理，专门负责以下维度的代码审查：

${checks}

## 规则
1. 只报告你发现的实际问题，不要编造
2. 对每个问题给出具体文件路径和行号
3. 严重程度判断标准：
   - critical（🔴）：可能导致运行时错误、安全漏洞、数据损坏
   - medium（🟡）：影响可维护性或性能，但不会立即导致故障
   - suggestion（🟢）：改进建议，非必须修复
4. 如果没有发现问题，返回空数组

${knowledgeCtx}
${outputFormat(dimensions)}`;
}

/**
 * 创建 5 个审查子代理定义。
 * @param knowledgeCtx 已格式化的知识库上下文文本
 */
export function createReviewAgents(knowledgeCtx: string): SubagentDef[] {
  const agents: SubagentDef[] = [
    {
      name: 'review-architecture-style',
      description: '审查架构一致性与代码风格',
      ...BASE_CONFIG,
      systemPrompt: buildSystemPrompt(
        'architecture-style',
        ['architecture', 'style'],
        knowledgeCtx,
      ),
    },
    {
      name: 'review-types-errors',
      description: '审查类型安全与错误处理',
      ...BASE_CONFIG,
      systemPrompt: buildSystemPrompt('types-errors', ['types', 'errors'], knowledgeCtx),
    },
    {
      name: 'review-tests-docs',
      description: '审查测试覆盖与文档同步',
      ...BASE_CONFIG,
      systemPrompt: buildSystemPrompt('tests-docs', ['tests', 'docs'], knowledgeCtx),
    },
    {
      name: 'review-security',
      description: '安全审查',
      ...BASE_CONFIG,
      systemPrompt: buildSystemPrompt('security', ['security'], knowledgeCtx),
    },
    {
      name: 'review-performance-maintainability',
      description: '审查性能与可维护性',
      ...BASE_CONFIG,
      systemPrompt: buildSystemPrompt(
        'performance-maintainability',
        ['performance', 'maintainability'],
        knowledgeCtx,
      ),
    },
  ];

  return agents;
}

/**
 * 解析子代理输出的 JSON 为 ReviewIssue[]。
 *
 * 解析失败返回 `null`（**无法解析 ≠ 没有发现问题**）。
 *
 * K16（v5.0 T23.3 实测）：旧实现解析失败直接返回 `[]`，与「子代理说没有发现问题」
 * 完全同形 —— 5 个组全部回了乱码/报错文案时，报告就渲染成「✅ 未发现明显问题」+ exit 0。
 * 现在把「解析不了」与「解析出空数组」分开：前者计入「该维度未完成」。
 */
export function tryParseReviewOutput(raw: string, group: ReviewAgentGroup): ReviewIssue[] | null {
  try {
    // 提取 JSON 块
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw];
    const jsonStr = (jsonMatch[1] ?? raw).trim();
    const parsed: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const arr = parsed as Array<Record<string, unknown>>;
    const dimensions = AGENT_DIMENSIONS_MAP[group];

    return arr.map(
      (item: Record<string, unknown>): ReviewIssue => ({
        dimension: (item.dimension as ReviewDimension) ?? dimensions[0],
        severity: (item.severity as Severity) ?? 'medium',
        file: (item.file as string) ?? '',
        line: typeof item.line === 'number' ? item.line : undefined,
        title: (item.title as string) ?? '',
        description: (item.description as string) ?? '',
        suggestion: typeof item.suggestion === 'string' ? item.suggestion : undefined,
      }),
    );
  } catch {
    return null;
  }
}

/**
 * 解析子代理输出的 JSON 为 ReviewIssue[]（兼容旧行为：解析失败返回空数组）。
 *
 * ⚠️ **审查链路不要用它**——用 `tryParseReviewOutput` 才能区分「没审到」与「没问题」。
 * 保留本函数只为不破坏既有调用方的签名（内部已改为委托）。
 */
export function parseReviewOutput(raw: string, group: ReviewAgentGroup): ReviewIssue[] {
  return tryParseReviewOutput(raw, group) ?? [];
}

// ── 失败分类（K16：未完成原因要说清是 401 / 超时 / 网络）──────────

/** 失败分类结果。 */
export interface FailureClassification {
  reason: ReviewIncompleteReason;
  /** 便于人读的原因摘要（保留原始错误里最有诊断价值的那一句）。 */
  detail: string;
}

/** 从错误文本里提炼「一句话原因」：优先保留 HTTP 状态码与中文说明，去掉堆栈与超长 JSON。 */
function condense(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

/**
 * 把子代理的失败原因归类（纯函数：只读字符串，无 IO、无时钟）。
 *
 * 判据按「用户下一步该做什么」划分，而不是按错误对象类型：
 * - 401/403 → 检查 Key（`concertoai doctor` / `concertoai login`）
 * - 402 / 余额不足 → 充值
 * - 连不上（DNS / 拒绝连接 / 代理）→ 查网络
 * - 超时 → 加大超时或缩小审查范围
 * - 轮数上限 → 缩小范围
 * - 解析失败 → 模型输出不可用（可重试）
 */
export function classifySubagentFailure(error: string | undefined): FailureClassification {
  const text = `${error ?? ''}`;
  const detail = condense(text) || '未提供错误详情';

  // 余额 / 配额优先于 401：DeepSeek 余额不足返回 402，若误判成 Key 问题会让人白折腾
  if (/HTTP\s*402|Insufficient\s+Balance|余额不足|insufficient_quota|quota/i.test(text)) {
    return { reason: 'quota', detail };
  }
  if (
    /HTTP\s*401|HTTP\s*403|Authentication\s+Fails|invalid\s+api\s+key|Unauthorized|Forbidden|api\s*key\s*.*invalid/i.test(
      text,
    )
  ) {
    return { reason: 'unauthorized', detail };
  }
  if (/超时|timeout|timed\s*out|TimeoutError|AbortError/i.test(text)) {
    return { reason: 'timeout', detail };
  }
  if (
    /fetch\s+failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket\s+hang\s+up|network|代理|proxy/i.test(
      text,
    )
  ) {
    return { reason: 'network', detail };
  }
  if (/轮上限|maxTurns|max\s*turns/i.test(text)) {
    return { reason: 'turn-limit', detail };
  }
  return { reason: 'error', detail };
}

/** Agent group → dimensions 映射（从 types.ts 复制）。 */
const AGENT_DIMENSIONS_MAP: Record<ReviewAgentGroup, ReviewDimension[]> = {
  'architecture-style': ['architecture', 'style'],
  'types-errors': ['types', 'errors'],
  'tests-docs': ['tests', 'docs'],
  security: ['security'],
  'performance-maintainability': ['performance', 'maintainability'],
};
