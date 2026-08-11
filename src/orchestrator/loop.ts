/**
 * 对抗性闭环编排（v3.0 M3 / T3.5，§3.2 对抗性闭环）。
 *
 * 完整流程：Coder 实现 → Reviewer 审查 → reject 则反馈 Coder 修复 →
 * approve 则 QA 验证 → QA 失败则反馈 Coder 修复 → 直至 Reviewer approve 且 QA 全绿。
 *
 * 关键设计：
 * - 循环次数 ≤ MAX_LOOP_ATTEMPTS（5），超过则退出并保留中间结果（供人工检查），
 *   触发 onRollback 回调（T3.6 事务回滚接入点）或由调用方决定保留快照（§8.1）；
 * - 每轮结果记录到上下文（code/review-result/test-report artifacts），供可观测性 T5.1；
 * - 终止条件：Reviewer action=approve 且 QA passed；
 * - 依赖接口 CoderLike/ReviewerLike/QaLike（结构兼容 CoderAgent/TeamReviewerAgent/QaAgent），
 *   测试注入 Fake 实现，避免单测触发真实模型与 verify。
 */

import type { ArchitectSpec } from '../agents/architect';
import type { CoderFile, CoderInput, CoderOutput } from '../agents/coder';
import type { QaInput, QaReport } from '../agents/qa';
import type { ReviewAction, ReviewIssue, ReviewResult, ReviewScope } from '../reviewer';
import { createArtifact, enforceLimit } from './context';
import type { AgentContext, Artifact } from './types';

// ── 常量 ──────────────────────────────────────────────────────

/** 闭环最大循环次数（代码生成/修复次数，超过即退出并保留中间结果）。 */
export const MAX_LOOP_ATTEMPTS = 5;

// ── 依赖接口（结构兼容具体 Agent，测试可注入 Fake）──────────

/** Coder 依赖（CoderAgent.execute 结构兼容）。 */
export interface CoderLike {
  execute(input: CoderInput, context: AgentContext): Promise<CoderOutput>;
}

/** Reviewer 依赖（TeamReviewerAgent.execute 结构兼容；input 与 ReviewInput 同构）。 */
export interface ReviewerLike {
  execute(
    input: { description: string; scope: ReviewScope },
    context: AgentContext,
  ): Promise<ReviewResult>;
}

/** QA 依赖（QaAgent.execute 结构兼容）。 */
export interface QaLike {
  execute(input: QaInput, context: AgentContext): Promise<QaReport>;
}

// ── 类型定义 ──────────────────────────────────────────────────

/** 闭环选项。 */
export interface TeamLoopOptions {
  /** Coder（实现/修复代码）。 */
  coder: CoderLike;
  /** Reviewer（审查，action approve/reject）。 */
  reviewer: ReviewerLike;
  /** QA（执行 verify）。 */
  qa: QaLike;
  /** 初始 ArchitectSpec（T3.1 设计输出，Coder 首轮实现输入）。 */
  spec: ArchitectSpec;
  /** 初始上下文（会话/任务骨架，artifacts 会随每轮追加）。 */
  context: AgentContext;
  /** 每轮记录回调（可观测性 T5.1 消费；phase 区分 implement/review/qa）。 */
  onAttempt?: (record: LoopRoundRecord) => void;
  /** 超限回滚回调（T3.6 事务回滚接入点；失败/超限时触发，保留中间结果）。 */
  onRollback?: (reason: string) => Promise<void> | void;
}

/** 单轮记录（供可观测性与审计）。 */
export interface LoopRoundRecord {
  /** 循环序号（代码生成/修复次数，从 1 开始）。 */
  attempt: number;
  /** 阶段：implement=实现 / review=审查 / qa=测试。 */
  phase: 'implement' | 'review' | 'qa';
  /** 该轮产出文件（implement/fix 阶段）。 */
  files?: CoderFile[];
  /** Reviewer 结果（review 阶段）。 */
  review?: ReviewResult;
  /** QA 报告（qa 阶段）。 */
  qa?: QaReport;
}

/** 闭环最终结果。 */
export interface TeamLoopResult {
  /** 是否成功终止（Reviewer approve 且 QA 全绿）。 */
  ok: boolean;
  /** 实际循环次数（代码生成/修复次数，≤ MAX_LOOP_ATTEMPTS）。 */
  attempts: number;
  /** 每轮记录（含 review/qa 结果，供可观测性 T5.1）。 */
  records: LoopRoundRecord[];
  /** 最终产出文件（成功或超限保留的中间结果）。 */
  finalFiles: CoderFile[];
  /** 最终审查结果（最后一次 review）。 */
  finalReview?: ReviewResult;
  /** 最终 QA 报告（最后一次 qa；未进入 QA 时缺省）。 */
  finalQa?: QaReport;
  /** 更新后的上下文（含全部轮次 artifacts）。 */
  context: AgentContext;
  /** 中文摘要（成功/超限/回滚语义）。 */
  summary: string;
}

// ── 上下文工件记录（每轮追加，供可观测性）──────────────────

/** 追加 Coder 产出为 code artifacts（path + content，来源追踪 coder）。 */
function appendCodeArtifacts(
  context: AgentContext,
  files: CoderFile[],
  attempt: number,
): AgentContext {
  const artifacts: Artifact[] = files.map((f, i) =>
    createArtifact({
      id: `loop-${attempt}-code-${i}`,
      type: 'code',
      path: f.path,
      content: f.content,
      fromAgent: 'coder',
      messageId: `loop-${attempt}-implement`,
      taskId: context.taskId,
    }),
  );
  return withArtifacts(context, artifacts);
}

/** 追加 Reviewer 结果为 review-result artifact。 */
function appendReviewArtifact(
  context: AgentContext,
  review: ReviewResult,
  attempt: number,
): AgentContext {
  const artifact = createArtifact({
    id: `loop-${attempt}-review`,
    type: 'review-result',
    content: review.summary,
    fromAgent: 'reviewer',
    messageId: `loop-${attempt}-review`,
    taskId: context.taskId,
  });
  return withArtifacts(context, [artifact]);
}

/** 追加 QA 结果为 test-report artifact。 */
function appendQaArtifact(context: AgentContext, qa: QaReport, attempt: number): AgentContext {
  const artifact = createArtifact({
    id: `loop-${attempt}-qa`,
    type: 'test-report',
    content: qa.summary,
    fromAgent: 'qa',
    messageId: `loop-${attempt}-qa`,
    taskId: context.taskId,
  });
  return withArtifacts(context, [artifact]);
}

/** 合并 artifacts 到上下文副本（超限截断，防上下文无限膨胀）。 */
function withArtifacts(context: AgentContext, artifacts: Artifact[]): AgentContext {
  const merged: AgentContext = {
    ...context,
    artifacts: [...context.artifacts, ...artifacts],
  };
  return enforceLimit(merged).context;
}

/**
 * QA 失败详情 → ReviewIssue[]（dimension=tests，供 Coder 修复模式消费）。
 *
 * v3.1.1 边界修复：`passed=false` 但 `failedItems` 为空（如无 package.json 目录跑
 * `npm run verify` 失败、解析不出具体失败项）时，仍返回 1 条通用 critical issue——
 * 否则空数组会让 CoderAgent 的 `isFix = issues.length > 0` 判定为 false，误入实现模式
 * 抛「缺少 ArchitectSpec」，导致闭环在修复轮直接失败而非尝试修复。
 */
export function qaFailedToIssues(qa: QaReport): ReviewIssue[] {
  if (!qa.passed && qa.failedItems.length === 0) {
    return [
      {
        dimension: 'tests',
        severity: 'critical',
        file: 'unknown',
        line: undefined,
        title: '自动化测试失败',
        description: qa.summary || 'npm run verify 未通过（无具体失败项）',
        suggestion: '请检查代码实现，确保项目 npm run verify 通过',
      },
    ];
  }
  return qa.failedItems.map((item) => ({
    dimension: 'tests',
    severity: 'critical',
    file: item.file,
    line: undefined,
    title: item.testName ?? '测试失败',
    description: item.error,
    suggestion: undefined,
  }));
}

// ── 闭环编排 ──────────────────────────────────────────────────

/**
 * 执行对抗性闭环。
 *
 * 流程：实现(attempt=1) → [review → reject? 修复] → approve → [qa → failed? 修复] →
 * 直至 approve+passed 或 attempts 超限（触发 onRollback，保留中间结果）。
 */
export async function runTeamLoop(options: TeamLoopOptions): Promise<TeamLoopResult> {
  const { coder, reviewer, qa, spec, onAttempt, onRollback } = options;
  // 拷贝上下文避免副作用；artifacts 随每轮追加
  let ctx: AgentContext = { ...options.context, artifacts: [...options.context.artifacts] };
  const records: LoopRoundRecord[] = [];
  const description = spec.requirement;

  let attempt = 1;
  let currentFiles: CoderFile[] = [];
  let finalReview: ReviewResult | undefined;
  let finalQa: QaReport | undefined;

  /** 记录一轮并回调（可观测性）。 */
  const record = (r: LoopRoundRecord): void => {
    records.push(r);
    onAttempt?.(r);
  };

  /** 修复入口：Reviewer reject 或 QA 失败 → Coder fix mode（返回新 attempt）。 */
  const fix = async (issues: ReviewIssue[]): Promise<number> => {
    attempt += 1;
    const output = await coder.execute({ description, issues }, ctx);
    currentFiles = output.files;
    ctx = appendCodeArtifacts(ctx, currentFiles, attempt);
    record({ attempt, phase: 'implement', files: currentFiles });
    return attempt;
  };

  /** 超限退出：触发回滚回调（T3.6），保留中间结果供人工检查。 */
  const failExceeded = async (reason: string): Promise<TeamLoopResult> => {
    await onRollback?.(reason);
    return {
      ok: false,
      attempts: attempt,
      records,
      finalFiles: currentFiles,
      finalReview,
      finalQa,
      context: ctx,
      summary: `❌ 对抗性闭环未收敛：${attempt} 轮后仍失败（${reason}），已保留中间结果供人工检查`,
    };
  };

  try {
    // 1. 初始实现（attempt = 1）
    const output = await coder.execute({ description, spec }, ctx);
    currentFiles = output.files;
    ctx = appendCodeArtifacts(ctx, currentFiles, attempt);
    record({ attempt, phase: 'implement', files: currentFiles });

    // 2. 审查 + 测试闭环（最多 MAX_LOOP_ATTEMPTS 次代码生成）
    for (;;) {
      // 2a. Reviewer 审查
      const scopePaths = currentFiles.map((f) => f.path);
      const review = await reviewer.execute(
        { description: `审查第 ${attempt} 轮代码`, scope: { type: 'files', paths: scopePaths } },
        ctx,
      );
      finalReview = review;
      ctx = appendReviewArtifact(ctx, review, attempt);
      record({ attempt, phase: 'review', review });

      // 2b. reject → 打回 Coder 修复（超限则退出）
      if (review.action === 'reject') {
        if (attempt >= MAX_LOOP_ATTEMPTS) {
          return failExceeded('审查连续未通过，达到闭环循环上限');
        }
        await fix(review.issues);
        continue;
      }

      // 2c. approve → QA 验证
      const qaReport = await qa.execute({ description }, ctx);
      finalQa = qaReport;
      ctx = appendQaArtifact(ctx, qaReport, attempt);
      record({ attempt, phase: 'qa', qa: qaReport });

      // 2d. QA 全绿 → 闭环成功终止
      if (qaReport.passed) {
        return {
          ok: true,
          attempts: attempt,
          records,
          finalFiles: currentFiles,
          finalReview,
          finalQa,
          context: ctx,
          summary: `✅ 对抗性闭环成功：${attempt} 轮实现/修复，Reviewer approve 且 QA 全绿（${qaReport.testFiles} 文件 / ${qaReport.testCases} 用例）`,
        };
      }

      // 2e. QA 失败 → 打回 Coder 修复（超限则退出）
      if (attempt >= MAX_LOOP_ATTEMPTS) {
        return failExceeded('QA 连续未通过，达到闭环循环上限');
      }
      await fix(qaFailedToIssues(qaReport));
    }
  } catch (err) {
    // Agent 执行异常 → 视为闭环失败，触发回滚并保留中间结果
    const message = err instanceof Error ? err.message : String(err);
    await onRollback?.(message);
    return {
      ok: false,
      attempts: attempt,
      records,
      finalFiles: currentFiles,
      finalReview,
      finalQa,
      context: ctx,
      summary: `❌ 对抗性闭环失败：${message}（已保留中间结果供人工检查）`,
    };
  }
}

/** 导出闭环中使用的动作类型（供可观测性/测试断言）。 */
export type { ReviewAction };
