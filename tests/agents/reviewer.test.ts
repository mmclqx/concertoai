/**
 * Team Reviewer Agent 测试（v3.0 M3 / T3.3）。
 *
 * 覆盖验收标准：
 * - ReviewResult 结构化输出（action + issues[] + summary）；
 * - action 判定：🔴 critical → 必 reject；🟡 medium → 可 reject；🟢 suggestion → 不阻断；
 * - 'reject' → 打回 Coder 修复；'approve' → 进入 QA（summary 语义）；
 * - 兼容 v2.1 9 维审查能力（引擎注入 ReviewEngineLike，生产为 ReviewerEngine）；
 * - 保留 v2.1「自动修正 🟢 走审批」能力（autoFix 委托）。
 */
import { describe, expect, it } from 'vitest';
import { type ReviewEngineLike, TeamReviewerAgent } from '../../src/agents';
import type { AgentContext } from '../../src/orchestrator';
import {
  ALL_DIMENSIONS,
  buildReviewResult,
  determineReviewAction,
  type ReviewContextArtifact,
  type ReviewIssue,
  type ReviewReport,
  type ReviewScope,
} from '../../src/reviewer';

// ── 测试辅助 ──────────────────────────────────────────────────

/** 构造一个最小 AgentContext。 */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess-1',
    taskId: 'task-reviewer',
    parentTaskId: 'task-0',
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

/** 构造 ReviewIssue。 */
function makeIssue(
  severity: ReviewIssue['severity'],
  overrides: Partial<ReviewIssue> = {},
): ReviewIssue {
  return {
    dimension: 'types',
    severity,
    file: 'src/a.ts',
    title: `问题-${severity}`,
    description: '描述',
    ...overrides,
  };
}

/** 从 issues 构造 ReviewReport（自动统计维度汇总）。 */
function makeReport(issues: ReviewIssue[], testPassed: boolean | null = null): ReviewReport {
  const summary = {} as ReviewReport['summary'];
  for (const dim of ALL_DIMENSIONS) {
    summary[dim] = { critical: 0, medium: 0, suggestion: 0 };
  }
  for (const issue of issues) {
    summary[issue.dimension][issue.severity] += 1;
  }
  return {
    scope: 'src/a.ts',
    timestamp: '2026-08-09T00:00:00.000Z',
    testPassed,
    issues,
    summary,
    durationMs: 10,
  };
}

/** Fake 审查引擎（支持 autoFix，记录最近一次 review 选项供 I2 断言）。 */
class FakeEngine implements ReviewEngineLike {
  report: ReviewReport;
  fixed = 0;
  lastOptions?: { scope: ReviewScope; contextArtifacts?: ReviewContextArtifact[] };

  constructor(report: ReviewReport) {
    this.report = report;
  }

  async review(options: {
    scope: ReviewScope;
    contextArtifacts?: ReviewContextArtifact[];
  }): Promise<ReviewReport> {
    this.lastOptions = options;
    return this.report;
  }

  async autoFix(report: ReviewReport): Promise<{
    report: ReviewReport;
    fixed: number;
    rolledBack: boolean;
  }> {
    this.fixed = 1;
    return { report, fixed: 1, rolledBack: false };
  }
}

// ── determineReviewAction：action 判定 ────────────────────────

describe('determineReviewAction（🔴🟡 必/可 reject，🟢 不阻断）', () => {
  it('🔴 critical 存在 → reject（必打回）', () => {
    expect(determineReviewAction([makeIssue('critical')])).toBe('reject');
  });

  it('🟡 medium 存在（无 critical）→ normal 下结合 testPassed（QA 失败 → reject；缺省 → approve）', () => {
    // v3.1 M5 / T5.4：normal 下 medium「可 reject」——QA 失败时 reject，否则不阻断
    expect(
      determineReviewAction([makeIssue('medium')], { severity: 'normal', testPassed: false }),
    ).toBe('reject');
    expect(determineReviewAction([makeIssue('medium')])).toBe('approve');
    // strict 下 medium 无条件 reject（与 v3.0 默认不同）
    expect(determineReviewAction([makeIssue('medium')], { severity: 'strict' })).toBe('reject');
  });

  it('仅 🟢 suggestion → approve（不阻断）', () => {
    expect(determineReviewAction([makeIssue('suggestion')])).toBe('approve');
  });

  it('无问题 → approve', () => {
    expect(determineReviewAction([])).toBe('approve');
  });

  it('critical + suggestion 混合 → reject（critical 优先）', () => {
    expect(determineReviewAction([makeIssue('suggestion'), makeIssue('critical')])).toBe('reject');
  });
});

// ── buildReviewResult：Report → Result 转换 ───────────────────

describe('buildReviewResult（结构化输出）', () => {
  it('含 critical → action=reject，summary 含计数与打回语义', () => {
    const report = makeReport([makeIssue('critical'), makeIssue('suggestion')], true);
    const result = buildReviewResult(report);
    expect(result.action).toBe('reject');
    expect(result.issues).toHaveLength(2);
    expect(result.testPassed).toBe(true);
    expect(result.summary).toContain('🔴×1');
    expect(result.summary).toContain('🟢×1');
    expect(result.summary).toContain('打回 Coder 修复');
    expect(result.report).toBe(report); // 保留完整报告供可观测性
  });

  it('仅 suggestion → action=approve，summary 含进入 QA 语义', () => {
    const report = makeReport([makeIssue('suggestion')], null);
    const result = buildReviewResult(report);
    expect(result.action).toBe('approve');
    expect(result.summary).toContain('通过，进入 QA');
    expect(result.testPassed).toBeNull();
  });

  it('issues 为 [] → action=approve', () => {
    const result = buildReviewResult(makeReport([]));
    expect(result.action).toBe('approve');
  });
});

// ── TeamReviewerAgent ─────────────────────────────────────────

describe('TeamReviewerAgent（标准 Agent 契约）', () => {
  it('def 契约：name=reviewer，权限只读（fail-closed）', () => {
    const agent = new TeamReviewerAgent({ engine: new FakeEngine(makeReport([])) });
    expect(agent.def.name).toBe('reviewer');
    expect(agent.def.version).toBe('1.0.0');
    expect(agent.def.permissions.map((p) => p.tool)).toEqual([
      'read_file',
      'list_directory',
      'search_content',
    ]);
  });

  it('execute：调用引擎审查 → 输出 ReviewResult（approve 场景）', async () => {
    const engine = new FakeEngine(makeReport([makeIssue('suggestion')]));
    const agent = new TeamReviewerAgent({ engine });
    const result = await agent.execute(
      { description: '审查代码', scope: { type: 'files', paths: ['src/a.ts'] } },
      makeContext(),
    );
    expect(result.action).toBe('approve');
    expect(result.issues).toHaveLength(1);
    expect(result.summary).toContain('进入 QA');
  });

  it('execute：critical 问题 → ReviewResult.action=reject（打回 Coder）', async () => {
    const engine = new FakeEngine(makeReport([makeIssue('critical', { file: 'src/b.ts' })]));
    const agent = new TeamReviewerAgent({ engine });
    const result = await agent.execute(
      { description: '审查代码', scope: { type: 'auto' } },
      makeContext(),
    );
    expect(result.action).toBe('reject');
    expect(result.issues[0]?.severity).toBe('critical');
    expect(result.summary).toContain('打回 Coder 修复');
  });

  it('execute：将显式上下文中的 code 工件传递给审查引擎（I2 修复，非 code 工件被过滤）', async () => {
    const engine = new FakeEngine(makeReport([]));
    const agent = new TeamReviewerAgent({ engine });
    await agent.execute(
      { description: '审查代码', scope: { type: 'auto' } },
      makeContext({
        artifacts: [
          {
            id: 'art-1',
            type: 'code',
            path: 'src/gen.ts',
            content: 'export const gen = 1;',
            metadata: { fromAgent: 'coder' },
          },
          {
            id: 'art-2',
            type: 'file',
            content: '纯文本工件',
            metadata: {},
          },
          {
            id: 'art-3',
            type: 'review-result',
            content: '不应透传的摘要',
            metadata: {},
          },
        ],
      }),
    );
    // code/file 工件透传给引擎（Reviewer 可见代码工件）
    expect(engine.lastOptions?.contextArtifacts).toEqual([
      { type: 'code', path: 'src/gen.ts', content: 'export const gen = 1;' },
      { type: 'file', content: '纯文本工件' },
    ]);
    // review-result 等非代码工件不进入审查范围
    expect(
      engine.lastOptions?.contextArtifacts?.some((a) => a.type !== 'code' && a.type !== 'file'),
    ).toBe(false);
  });

  it('execute：context 无 code 工件 → contextArtifacts 为空数组', async () => {
    const engine = new FakeEngine(makeReport([]));
    const agent = new TeamReviewerAgent({ engine });
    await agent.execute(
      { description: '审查代码', scope: { type: 'files', paths: ['src/a.ts'] } },
      makeContext(),
    );
    expect(engine.lastOptions?.contextArtifacts).toEqual([]);
    expect(engine.lastOptions?.scope).toEqual({ type: 'files', paths: ['src/a.ts'] });
  });

  it('autoFix：委托引擎修正 🟢 suggestion（保留 v2.1 能力）', async () => {
    const engine = new FakeEngine(makeReport([makeIssue('suggestion')]));
    const agent = new TeamReviewerAgent({ engine });
    const report = makeReport([makeIssue('suggestion', { suggestion: '建议' })]);
    const result = await agent.autoFix(report);
    expect(result.fixed).toBe(1);
    expect(result.rolledBack).toBe(false);
    expect(engine.fixed).toBe(1);
  });

  it('autoFix：引擎不支持时返回未修正（fixed=0）', async () => {
    const engine: ReviewEngineLike = {
      async review() {
        return makeReport([]);
      },
    };
    const agent = new TeamReviewerAgent({ engine });
    const report = makeReport([]);
    const result = await agent.autoFix(report);
    expect(result.fixed).toBe(0);
    expect(result.rolledBack).toBe(false);
  });
});
