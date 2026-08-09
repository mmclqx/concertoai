/**
 * 多 Agent 团队闭环 E2E（v3.0 M6 / T6.1）。
 *
 * 端到端串联验证（跨模块）：
 * - E2E-2：需求 → 拆解 → Architect 设计 spec → 对抗性闭环（Coder→Reviewer→QA）→ 交付；
 * - E2E-3：闭环超 5 次 → onRollback → SnapshotManager 事务回滚 → 文件恢复任务前状态。
 *
 * 依赖：M1-M5（types/context/loop/agents/transaction）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArchitectAgent,
  type ArchitectSpec,
  type CoderFile,
  type CoderInput,
  type CoderOutput,
  decomposeRequirement,
  type QaInput,
  type QaReport,
} from '../../src/agents';
import type { ChatCompletionChunk, ModelClient } from '../../src/model/client';
import {
  type AgentContext,
  type CoderLike,
  MAX_LOOP_ATTEMPTS,
  type QaLike,
  type ReviewerLike,
  runTeamLoop,
  SNAPSHOT_ROOT,
  SnapshotManager,
} from '../../src/orchestrator';
import type { ReviewIssue, ReviewResult, ReviewScope } from '../../src/reviewer';

// ── Fake 模型客户端 ───────────────────────────────────────────

class FakeModelClient implements ModelClient {
  private readonly replies: string[];

  constructor(replies: string[]) {
    this.replies = replies;
  }

  async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
    for (const text of this.replies) {
      yield {
        id: 'fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
    }
  }
}

// ── 测试辅助 ──────────────────────────────────────────────────

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess-e2e-loop',
    taskId: 'task-loop',
    parentTaskId: undefined,
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

/** 构造 ArchitectSpec。 */
const SPEC: ArchitectSpec = {
  requirement: '实现 TODO 应用',
  interfaces: [],
  files: [{ path: 'src/todo.ts', purpose: '核心逻辑' }],
  constraints: ['strict'],
};

/** 写盘版 Fake Coder：execute 真实写文件到 cwd + recordWrite 登记（供回滚验证）。 */
class DiskCoder implements CoderLike {
  calls = 0;

  constructor(
    private readonly cwd: string,
    private readonly tx: SnapshotManager,
  ) {}

  async execute(_input: CoderInput, context: AgentContext): Promise<CoderOutput> {
    this.calls += 1;
    void context;
    const version = `v${this.calls}`;
    const files: CoderFile[] = [{ path: 'src/todo.ts', content: `// ${version}` }];
    // 真实写盘 + 事务登记（模拟 Coder Agent 的 edit 写盘路径）
    await this.tx.recordWrite(
      'task-loop',
      files[0]?.path ?? 'src/todo.ts',
      files[0]?.content ?? '',
    );
    const full = path.join(this.cwd, files[0]?.path ?? 'src/todo.ts');
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, files[0]?.content ?? '', 'utf8');
    return { files };
  }
}

/** Fake Reviewer（按序返回 action）。 */
class FakeReviewer implements ReviewerLike {
  calls = 0;

  constructor(private readonly actions: ReviewResult['action'][]) {}

  async execute(
    input: { description: string; scope: ReviewScope },
    context: AgentContext,
  ): Promise<ReviewResult> {
    this.calls += 1;
    void input;
    void context;
    const action = this.actions[this.calls - 1] ?? 'approve';
    return {
      action,
      issues: action === 'reject' ? [makeIssue('critical')] : [makeIssue('suggestion')],
      summary: action === 'reject' ? '审查未通过' : '审查通过',
      testPassed: null,
    };
  }
}

/** Fake QA（按序返回 passed）。 */
class FakeQa implements QaLike {
  calls = 0;

  constructor(private readonly results: boolean[]) {}

  async execute(input: QaInput, context: AgentContext): Promise<QaReport> {
    this.calls += 1;
    void input;
    void context;
    const passed = this.results[this.calls - 1] ?? true;
    return {
      passed,
      testFiles: 51,
      testCases: passed ? 577 : 576,
      failedItems: passed
        ? []
        : [{ file: 'tests/todo.test.ts', testName: '应能创建', error: 'AssertionError' }],
      timedOut: false,
      durationMs: 100,
      summary: passed ? '通过' : '失败',
    };
  }
}

function makeIssue(severity: ReviewIssue['severity']): ReviewIssue {
  return {
    dimension: 'types',
    severity,
    file: 'src/todo.ts',
    title: '问题',
    description: '描述',
  };
}

// ── E2E-2：需求 → 拆解 → Architect 设计 → 对抗性闭环 → 交付 ──

describe('E2E：需求 → 拆解 → 设计 → 闭环 → 交付（全链路）', () => {
  it('FakeModel 拆解任务 → Architect 生成 spec → runTeamLoop approve + QA 通过', async () => {
    // 1. FakeModel 拆解出「architect 设计」任务
    const tasksJson = JSON.stringify([
      { id: 't1', description: '设计 TODO 应用接口', agent: 'architect', dependencies: [] },
    ]);
    const client = new FakeModelClient([tasksJson]);
    const tasks = await decomposeRequirement(client, 'fake', '实现 TODO 应用');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agent).toBe('architect');

    // 2. Architect Agent 用 Fake client 生成 spec（跨模块：orchestrator types + agents）
    const specClient = new FakeModelClient([
      JSON.stringify({
        requirement: '实现 TODO 应用',
        interfaces: [],
        files: [{ path: 'src/todo.ts', purpose: '核心逻辑' }],
        constraints: ['strict'],
      }),
    ]);
    const architect = new ArchitectAgent({ client: specClient, model: 'fake' });
    const spec = await architect.execute({ description: '实现 TODO 应用' }, makeContext());
    expect(spec.files).toHaveLength(1);

    // 3. 对抗性闭环（Coder → Reviewer → QA）：approve + 全绿 → 交付
    const coderFiles: CoderFile[] = [{ path: 'src/todo.ts', content: '// v1' }];
    const coder = {
      async execute(input: CoderInput, context: AgentContext): Promise<CoderOutput> {
        void input;
        void context;
        return { files: coderFiles };
      },
    };
    const reviewer = new FakeReviewer(['approve']);
    const qa = new FakeQa([true]);
    const result = await runTeamLoop({ coder, reviewer, qa, spec, context: makeContext() });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.finalReview?.action).toBe('approve');
    expect(result.finalQa?.passed).toBe(true);
    expect(result.finalFiles).toEqual(coderFiles);
    // 上下文含 code/review-result/test-report artifacts（可观测性可消费）
    const types = result.context.artifacts.map((a) => a.type);
    expect(types).toContain('code');
    expect(types).toContain('review-result');
    expect(types).toContain('test-report');
  });
});

// ── E2E-3：闭环超限 → onRollback → 事务回滚 → 文件恢复 ────────

describe('E2E：闭环超限 → 事务回滚 → 文件恢复（跨 loop + transaction）', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'concertoai-e2e-loop-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('Reviewer 持续 reject 超 5 次 → onRollback 触发 SnapshotManager 回滚 → 文件恢复', async () => {
    // 任务前原始文件（先建目录，writeFile 不自动创建父目录）
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await writeFile(path.join(cwd, 'src/todo.ts'), '原始内容', 'utf8');

    // 事务：任务开始前快照
    const tx = new SnapshotManager(cwd);
    await tx.begin('task-loop', ['src/todo.ts']);

    // 跑闭环：一直 reject（实现 1 次 + 修复 4 次 = 5 次代码生成后超限）
    const coder = new DiskCoder(cwd, tx);
    const reviewer = new FakeReviewer(['reject', 'reject', 'reject', 'reject', 'reject']);
    const qa = new FakeQa([true]);
    let rollbackReason: string | undefined;

    const result = await runTeamLoop({
      coder,
      reviewer,
      qa,
      spec: SPEC,
      context: makeContext(),
      onRollback: async (reason) => {
        rollbackReason = reason;
        // 超限 → 事务回滚（恢复所有文件到任务前状态）
        const rb = await tx.rollback('task-loop');
        expect(rb.ok).toBe(true);
      },
    });

    // 闭环未收敛：5 次后退出并保留中间结果
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_LOOP_ATTEMPTS);
    expect(rollbackReason).toBeDefined();
    expect(result.finalFiles).toHaveLength(1); // 中间结果保留

    // 文件恢复任务前状态（原子性）
    const content = await readFile(path.join(cwd, 'src/todo.ts'), 'utf8');
    expect(content).toBe('原始内容');

    // 快照已清理（回滚成功）
    let snapshotGone = true;
    try {
      await readFile(path.join(cwd, SNAPSHOT_ROOT, 'task-loop', 'files.json'), 'utf8');
      snapshotGone = false;
    } catch {
      snapshotGone = true;
    }
    expect(snapshotGone).toBe(true);
  });
});
