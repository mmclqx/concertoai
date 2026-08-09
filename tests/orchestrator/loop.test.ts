/**
 * 对抗性闭环测试（v3.0 M3 / T3.5）。
 *
 * 覆盖验收标准：
 * - 完整流程：Coder 实现 → Reviewer 审查 → reject 反馈 Coder 修复 → approve → QA 验证；
 * - QA 失败 → 反馈 Coder 修复 → 重测；
 * - 循环次数 ≤ MAX_LOOP_ATTEMPTS（5），超过退出并保留中间结果；
 * - 每轮记录到上下文（code/review-result/test-report artifacts）；
 * - 终止条件：Reviewer approve 且 QA 全绿；
 * - 超限时触发 onRollback（T3.6 接入点）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ArchitectSpec,
  CoderFile,
  CoderInput,
  CoderOutput,
  QaInput,
  QaReport,
} from '../../src/agents';
import type { AgentContext } from '../../src/orchestrator';
import {
  type CoderLike,
  type LoopRoundRecord,
  MAX_LOOP_ATTEMPTS,
  type QaLike,
  type ReviewerLike,
  runTeamLoop,
} from '../../src/orchestrator';
import type { ReviewIssue, ReviewResult, ReviewScope } from '../../src/reviewer';

// ── 测试辅助 ──────────────────────────────────────────────────

/** 构造最小 AgentContext。 */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess-1',
    taskId: 'task-loop',
    parentTaskId: 'task-0',
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

/** 构造 ArchitectSpec（T3.1 输出）。 */
const SPEC: ArchitectSpec = {
  requirement: '实现 TODO 应用',
  interfaces: [],
  files: [{ path: 'src/todo.ts', purpose: '核心逻辑' }],
  constraints: ['strict'],
};

/** 构造 Coder 输出。 */
function makeFiles(version: string): CoderFile[] {
  return [{ path: 'src/todo.ts', content: `// v${version}` }];
}

/** 构造 ReviewIssue。 */
function makeIssue(severity: ReviewIssue['severity']): ReviewIssue {
  return {
    dimension: 'types',
    severity,
    file: 'src/todo.ts',
    title: '问题',
    description: '描述',
  };
}

/** 构造 ReviewResult。 */
function makeReview(action: ReviewResult['action']): ReviewResult {
  return {
    action,
    issues: action === 'reject' ? [makeIssue('critical')] : [makeIssue('suggestion')],
    summary: action === 'reject' ? '审查未通过' : '审查通过',
    testPassed: null,
  };
}

/** 构造 QA 报告。 */
function makeQa(passed: boolean): QaReport {
  return {
    passed,
    testFiles: passed ? 51 : 51,
    testCases: passed ? 577 : 576,
    failedItems: passed
      ? []
      : [{ file: 'tests/todo.test.ts', testName: '应能创建', error: 'AssertionError' }],
    timedOut: false,
    durationMs: 100,
    summary: passed ? '通过' : '失败',
  };
}

/** 可编程 Fake Coder（记录调用，返回预设输出）。 */
class FakeCoder implements CoderLike {
  calls: Array<{ input: CoderInput; context: AgentContext }> = [];

  constructor(
    private readonly outputs: CoderOutput[] = [],
    private readonly failOnCall?: (index: number) => boolean,
  ) {}

  async execute(input: CoderInput, context: AgentContext): Promise<CoderOutput> {
    const index = this.calls.length;
    this.calls.push({ input, context });
    if (this.failOnCall?.(index) === true) {
      throw new Error('coder 爆炸');
    }
    const output = this.outputs[index];
    if (output !== undefined) {
      return output;
    }
    const files = makeFiles(`attempt-${index + 1}`);
    return { files };
  }
}

/** 可编程 Fake Reviewer（按序返回预设 action）。 */
class FakeReviewer implements ReviewerLike {
  calls = 0;
  actions: ReviewResult['action'][];

  constructor(actions: ReviewResult['action'][]) {
    this.actions = actions;
  }

  async execute(
    input: { description: string; scope: ReviewScope },
    context: AgentContext,
  ): Promise<ReviewResult> {
    this.calls += 1;
    void input;
    void context;
    const action = this.actions[this.calls - 1] ?? 'approve';
    return makeReview(action);
  }
}

/** 可编程 Fake QA（按序返回预设结果）。 */
class FakeQa implements QaLike {
  calls = 0;
  results: boolean[];

  constructor(results: boolean[]) {
    this.results = results;
  }

  async execute(input: QaInput, context: AgentContext): Promise<QaReport> {
    this.calls += 1;
    void input;
    void context;
    const passed = this.results[this.calls - 1] ?? true;
    return makeQa(passed);
  }
}

// ── 闭环流程 ──────────────────────────────────────────────────

describe('runTeamLoop（对抗性闭环）', () => {
  it('一次通过：实现 → review approve → QA passed → ok', async () => {
    const coder = new FakeCoder();
    const reviewer = new FakeReviewer(['approve']);
    const qa = new FakeQa([true]);
    const result = await runTeamLoop({ coder, reviewer, qa, spec: SPEC, context: makeContext() });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(coder.calls).toHaveLength(1);
    expect(reviewer.calls).toBe(1);
    expect(qa.calls).toBe(1);
    expect(result.finalQa?.passed).toBe(true);
    expect(result.summary).toContain('成功');
  });

  it('review reject 一次 → Coder 修复 → approve → QA passed → ok（attempts=2）', async () => {
    const coder = new FakeCoder();
    const reviewer = new FakeReviewer(['reject', 'approve']);
    const qa = new FakeQa([true]);
    const result = await runTeamLoop({ coder, reviewer, qa, spec: SPEC, context: makeContext() });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    // 实现 1 次 + 修复 1 次
    expect(coder.calls).toHaveLength(2);
    expect(reviewer.calls).toBe(2);
    // 第二次调用是修复模式（带 issues）
    expect(coder.calls[1]?.input.issues).toBeDefined();
    expect(coder.calls[1]?.input.spec).toBeUndefined();
  });

  it('review approve → QA 失败一次 → Coder 修复 → QA passed → ok（attempts=2）', async () => {
    const coder = new FakeCoder();
    const reviewer = new FakeReviewer(['approve', 'approve']);
    const qa = new FakeQa([false, true]);
    const result = await runTeamLoop({ coder, reviewer, qa, spec: SPEC, context: makeContext() });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(qa.calls).toBe(2);
    expect(coder.calls).toHaveLength(2);
    // 修复输入 issues 来自 QA 失败（dimension=tests）
    expect(coder.calls[1]?.input.issues?.[0]?.dimension).toBe('tests');
  });

  it('循环上限：review 持续 reject → 第 5 次仍失败 → 退出并保留中间结果 + 触发 onRollback', async () => {
    const coder = new FakeCoder();
    // 一直 reject：实现 1 次 + 修复 4 次 = 5 次代码生成后超限
    const reviewer = new FakeReviewer(['reject', 'reject', 'reject', 'reject', 'reject']);
    const qa = new FakeQa([true]);
    let rollbackReason: string | undefined;
    const result = await runTeamLoop({
      coder,
      reviewer,
      qa,
      spec: SPEC,
      context: makeContext(),
      onRollback: (reason) => {
        rollbackReason = reason;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_LOOP_ATTEMPTS);
    expect(coder.calls).toHaveLength(MAX_LOOP_ATTEMPTS);
    expect(rollbackReason).toBeDefined();
    expect(result.summary).toContain('未收敛');
    // 保留中间结果（最终文件仍在）
    expect(result.finalFiles).toHaveLength(1);
  });

  it('QA 持续失败 → 达到上限退出并触发 onRollback', async () => {
    const coder = new FakeCoder();
    const reviewer = new FakeReviewer(['approve']);
    const qa = new FakeQa([false, false, false, false, false]);
    let rollbackReason: string | undefined;
    const result = await runTeamLoop({
      coder,
      reviewer,
      qa,
      spec: SPEC,
      context: makeContext(),
      onRollback: (reason) => {
        rollbackReason = reason;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_LOOP_ATTEMPTS);
    expect(qa.calls).toBe(MAX_LOOP_ATTEMPTS);
    expect(rollbackReason).toContain('QA');
  });

  it('每轮记录到上下文：code/review-result/test-report artifacts 累积', async () => {
    const coder = new FakeCoder();
    const reviewer = new FakeReviewer(['reject', 'approve']);
    const qa = new FakeQa([true]);
    const result = await runTeamLoop({ coder, reviewer, qa, spec: SPEC, context: makeContext() });

    const types = result.context.artifacts.map((a) => a.type);
    // 实现 code + 修复 code + review(reject) + review(approve) + qa
    expect(types).toContain('code');
    expect(types).toContain('review-result');
    expect(types).toContain('test-report');
    // 每轮记录存在
    expect(result.records.some((r) => r.phase === 'implement')).toBe(true);
    expect(result.records.some((r) => r.phase === 'review')).toBe(true);
    expect(result.records.some((r) => r.phase === 'qa')).toBe(true);
    // onAttempt 回调
    const seen: LoopRoundRecord[] = [];
    await runTeamLoop({
      coder: new FakeCoder(),
      reviewer,
      qa,
      spec: SPEC,
      context: makeContext(),
      onAttempt: (r) => seen.push(r),
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('Agent 抛异常 → 闭环失败，触发 onRollback 并保留中间结果', async () => {
    const coder = new FakeCoder([], () => true); // 首次调用即抛错
    const reviewer = new FakeReviewer(['approve']);
    const qa = new FakeQa([true]);
    let rollbackReason: string | undefined;
    const result = await runTeamLoop({
      coder,
      reviewer,
      qa,
      spec: SPEC,
      context: makeContext(),
      onRollback: (reason) => {
        rollbackReason = reason;
      },
    });

    expect(result.ok).toBe(false);
    expect(rollbackReason).toContain('coder 爆炸');
    expect(result.summary).toContain('失败');
  });

  it('MAX_LOOP_ATTEMPTS = 5（常量与文档同步）', () => {
    expect(MAX_LOOP_ATTEMPTS).toBe(5);
  });
});
