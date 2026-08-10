/**
 * Team Reviewer Agent（v3.0 M3 / T3.3，对抗性闭环审查角色）。
 *
 * 基于 v2.1 ReviewerEngine（9 维审查 / 5 并行子代理 / 自动测试 / 🟢 autoFix 审批）
 * 升级为团队对抗性闭环的审查角色：
 * - 输出结构化为 ReviewResult（action: 'approve' | 'reject' + issues[] + summary）；
 * - action 判定：🔴 critical → 必 reject；🟡 medium → 可 reject；🟢 suggestion → 不阻断；
 * - 'reject' → 打回 Coder 修复（T3.5 闭环消费）；'approve' → 进入 QA；
 * - 保留 v2.1「自动修正 🟢 建议走审批」能力（autoFix 委托给引擎）。
 *
 * 引擎依赖倒置（注入 ReviewEngineLike）：生产注入 v2.1 ReviewerEngine，
 * 测试注入 Fake 引擎，避免单测触发真实 9 维子代理与 npm run verify。
 */

import { z } from 'zod';
import type { AgentContext, AgentDef, Artifact } from '../orchestrator';
import { createAgentRuntimeState } from '../orchestrator';
import type {
  ReviewContextArtifact,
  ReviewReport,
  ReviewResult,
  ReviewScope,
  ReviewSeverity,
} from '../reviewer';
import { buildReviewResult } from '../reviewer';
import type { Agent } from './protocol';

// ── 类型定义 ──────────────────────────────────────────────────

/** 自动修正能力（v2.1 ReviewerEngine.autoFix 的抽象）。 */
export interface AutoFixLike {
  /** 自动修正 🟢 suggestion（返回修正数量与回滚标记；实际写盘由调用方审批）。 */
  autoFix(report: ReviewReport): Promise<{
    report: ReviewReport;
    fixed: number;
    rolledBack: boolean;
  }>;
}

/** Team Reviewer 可注入的审查引擎（v2.1 ReviewerEngine 满足；测试注入 Fake）。 */
export interface ReviewEngineLike extends Partial<AutoFixLike> {
  /** 执行完整审查（9 维并行子代理 + 自动测试），返回 v2.1 ReviewReport。 */
  review(options: {
    scope: ReviewScope;
    /** 显式上下文代码工件（v3.0 I2：Reviewer 直接阅读 Coder 产出，而非只依赖磁盘路径）。 */
    contextArtifacts?: ReviewContextArtifact[];
    /** 审查严重程度阈值（v3.1 M5 / T5.4）。 */
    severity?: ReviewSeverity;
  }): Promise<ReviewReport>;
}

/** Team Reviewer 输入。 */
export interface ReviewInput {
  /** 任务描述。 */
  description: string;
  /** 审查范围（v2.1 ReviewScope：files / auto / pr）。 */
  scope: ReviewScope;
}

/** Team Reviewer 输出 schema（zod，与 ReviewResult 同步）。 */
export const reviewResultSchema = z.object({
  action: z.enum(['approve', 'reject']),
  issues: z.array(z.unknown()),
  summary: z.string(),
  testPassed: z.boolean().nullable(),
  report: z.unknown().optional(),
});

/** Team Reviewer Agent 选项。 */
export interface TeamReviewerOptions {
  /** 审查引擎（v2.1 ReviewerEngine：9 维并行子代理 + 自动测试 + autoFix）。 */
  engine: ReviewEngineLike;
  /** 审查严重程度阈值（v3.1 M5 / T5.4：strict / normal / lenient，缺省 normal）。 */
  severity?: ReviewSeverity;
}

/** 类型守卫：context.artifacts 中可交给审查引擎的代码工件（code/file）。 */
function isCodeArtifact(a: Artifact): a is Artifact & { type: 'code' | 'file' } {
  return a.type === 'code' || a.type === 'file';
}

/**
 * Team Reviewer Agent（标准 Agent 契约）。
 *
 * execute：调用审查引擎 → buildReviewResult（判定 action + 中文 summary）；
 * 显式上下文中的 code/file 工件随审查调用传递给引擎（I2 修复，Reviewer 可见代码工件）。
 */
export class TeamReviewerAgent implements Agent {
  /** Agent 定义（name=reviewer，输入 ReviewInput / 输出 ReviewResult，权限只读）。 */
  readonly def: AgentDef = {
    name: 'reviewer',
    version: '1.0.0',
    interfaces: {
      input: z.object({
        description: z.string(),
        scope: z.unknown(),
      }),
      output: reviewResultSchema,
      version: '1.0.0',
    },
    permissions: [
      // reviewer 只读（读文件/搜索），不写文件、不执行命令（fail-closed 最小权限）
      { tool: 'read_file' },
      { tool: 'list_directory' },
      { tool: 'search_content' },
    ],
  };

  /** 运行时状态（与任务级 AgentState 解耦，ADR-016 #3）。 */
  runtimeState = createAgentRuntimeState();

  private readonly options: TeamReviewerOptions;

  constructor(options: TeamReviewerOptions) {
    this.options = options;
  }

  /** 执行核心：审查引擎 → ReviewResult（action 判定 + summary）。 */
  async execute(input: ReviewInput, context: AgentContext): Promise<ReviewResult> {
    // v3.0 I2 修复：不再忽略显式上下文，将 context.artifacts 中的 code/file 工件
    // 传递给审查引擎（Reviewer 能看到 Coder 产出的代码，含无磁盘路径的虚拟工件）
    const contextArtifacts = context.artifacts
      .filter(isCodeArtifact)
      .map((a) => ({ type: a.type, path: a.path, content: a.content }));
    const report = await this.options.engine.review({
      scope: input.scope,
      contextArtifacts,
      severity: this.options.severity,
    });
    return buildReviewResult(report, this.options.severity);
  }

  /**
   * 自动修正 🟢 suggestion（保留 v2.1 能力）。
   * 委托给引擎的 autoFix（若存在）；引擎不支持时返回未修正。
   */
  async autoFix(report: ReviewReport): Promise<{
    report: ReviewReport;
    fixed: number;
    rolledBack: boolean;
  }> {
    const engine = this.options.engine as AutoFixLike | undefined;
    if (engine?.autoFix === undefined) {
      return { report, fixed: 0, rolledBack: false };
    }
    return engine.autoFix(report);
  }

  /** 发送消息（闭环暂未启用，no-op 占位）。 */
  async send(): Promise<void> {
    // 闭环消息路由由 T3.5 编排层接入。
  }

  /** 接收消息（闭环暂未启用，返回无回复）。 */
  async receive(): Promise<undefined> {
    return undefined;
  }
}
