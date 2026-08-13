/**
 * team --parallel 并行执行测试（v4.0 M5 / T5.1~T5.3）。
 *
 * 覆盖验收标准：
 * - 自然语言并行意图识别（「同时/并行/分别/各自/并发」→ true；普通描述 → false）；
 * - 任务分层：无依赖全并行 / 有依赖分层 / 纯串行链 parallelizable=false（降级串行提示）；
 * - 组内文件冲突检测 + 冲突串行化（不并行写同一文件）+ 汇总冲突提示；
 * - 并行执行：每任务独立 context/taskId + 真实并发（活跃 coder 数 = 2）；
 * - runTeamCommand 集成：自然语言触发 / 显式 --parallel / 汇总输出。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QaReport } from '../../src/agents';
import type { OrchestratorTask } from '../../src/agents/orchestrator';
import { formatTeamProgress, runTeamCommand } from '../../src/cli/team';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import type { AgentContext, CoderLike, QaLike, ReviewerLike } from '../../src/orchestrator';
import {
  buildParallelGroups,
  detectGroupConflicts,
  detectParallelIntent,
  isParallelizable,
  runParallelTeams,
} from '../../src/orchestrator';

/** 拆解输出：两个独立 coder 任务（无依赖 → 可并行）。 */
const DECOMPOSE_TWO_TASKS = JSON.stringify([
  {
    id: 't1',
    description: '修复登录模块的 bug',
    agent: 'coder',
    dependencies: [],
    files: ['src/login.ts'],
  },
  {
    id: 't2',
    description: '重构用户模块的类型定义',
    agent: 'coder',
    dependencies: [],
    files: ['src/user.ts'],
  },
]);

/** 拆解输出：串行链（t1 → t2 → t3，无法并行）。 */
const DECOMPOSE_SERIAL = JSON.stringify([
  {
    id: 't1',
    description: '第一步',
    agent: 'coder',
    dependencies: [],
    files: ['src/a.ts'],
  },
  {
    id: 't2',
    description: '第二步（依赖 t1）',
    agent: 'coder',
    dependencies: ['t1'],
    files: ['src/b.ts'],
  },
  {
    id: 't3',
    description: '第三步（依赖 t2）',
    agent: 'coder',
    dependencies: ['t2'],
    files: ['src/c.ts'],
  },
]);

/** 脚本式 FakeModel（team 内仅拆解调用一次模型）。 */
class FakeModel implements ModelClient {
  constructor(private readonly script: Array<{ content?: string }>) {}

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const step = this.script.shift();
    if (step === undefined) {
      throw new Error('FakeModel 脚本耗尽');
    }
    if (step.content !== undefined) {
      yield {
        id: 'fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [{ index: 0, delta: { content: step.content }, finish_reason: null }],
        usage: null,
      };
    }
  }
}

/** 记录并发的 Coder：active 峰值反映并行度；记录每次调用的 context（隔离断言）。 */
function makeCoder(files: Array<{ path: string; content: string }> = []) {
  let active = 0;
  let maxActive = 0;
  const contexts: AgentContext[] = [];
  const coder: CoderLike & {
    maxActive: () => number;
    contexts: () => AgentContext[];
  } = {
    maxActive: () => maxActive,
    contexts: () => contexts,
    async execute(_input: unknown, context: AgentContext) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      contexts.push(context);
      active -= 1;
      return { files };
    },
  };
  return coder;
}

/** Fake reviewer（approve 直通 QA）。 */
function makeReviewer(): ReviewerLike & { calls: number } {
  const reviewer = {
    calls: 0,
    async execute() {
      reviewer.calls += 1;
      return { action: 'approve' as const, issues: [], summary: '通过', testPassed: null };
    },
  };
  return reviewer;
}

/** Fake qa（passed 全绿）。 */
function makeQa(): QaLike & { calls: number } {
  const qa = {
    calls: 0,
    async execute(): Promise<QaReport> {
      qa.calls += 1;
      return {
        passed: true,
        testFiles: 1,
        testCases: 1,
        failedItems: [],
        timedOut: false,
        summary: '全部通过',
        durationMs: 1,
      };
    },
  };
  return qa;
}

/** 构造基础任务（用于纯函数测试）。 */
function task(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: overrides.id ?? 't1',
    description: overrides.description ?? '任务',
    agent: overrides.agent ?? 'coder',
    dependencies: overrides.dependencies ?? [],
    files: overrides.files ?? [],
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'team-parallel-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── T5.1 并行意图识别 ─────────────────────────────────────────

describe('detectParallelIntent（自然语言并行意图）', () => {
  it('强关键词 → true（同时/并行/分别/各自/并发/多线程）', () => {
    expect(detectParallelIntent('同时修复登录模块的 bug 和重构用户模块')).toBe(true);
    expect(detectParallelIntent('并行处理两个任务')).toBe(true);
    expect(detectParallelIntent('分别实现 A 和 B')).toBe(true);
    expect(detectParallelIntent('各自完成独立模块')).toBe(true);
    expect(detectParallelIntent('并发执行')).toBe(true);
    expect(detectParallelIntent('多线程处理')).toBe(true);
  });

  it('普通描述（无强关键词）→ false', () => {
    expect(detectParallelIntent('实现一个 TODO 应用')).toBe(false);
    expect(detectParallelIntent('请帮我完成这个项目')).toBe(false);
    expect(detectParallelIntent('修复登录模块的 bug')).toBe(false);
    expect(detectParallelIntent('')).toBe(false);
  });
});

// ── T5.1 任务分层 ─────────────────────────────────────────────

describe('buildParallelGroups / isParallelizable（分层）', () => {
  it('无依赖任务 → 同一层（可并行）', () => {
    const groups = buildParallelGroups([
      task({ id: 't1' }),
      task({ id: 't2' }),
      task({ id: 't3' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(isParallelizable(groups)).toBe(true);
  });

  it('有依赖 → 分层（依赖满足才进入下一层）', () => {
    const groups = buildParallelGroups([
      task({ id: 't1', files: ['a.ts'] }),
      task({ id: 't2', files: ['b.ts'] }),
      task({ id: 't3', dependencies: ['t1'], files: ['c.ts'] }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(groups[1]?.map((t) => t.id)).toEqual(['t3']);
    expect(isParallelizable(groups)).toBe(true);
  });

  it('纯串行链 → 每层单任务，parallelizable=false（降级串行）', () => {
    const groups = buildParallelGroups([
      task({ id: 't1', dependencies: [] }),
      task({ id: 't2', dependencies: ['t1'] }),
      task({ id: 't3', dependencies: ['t2'] }),
    ]);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([['t1'], ['t2'], ['t3']]);
    expect(isParallelizable(groups)).toBe(false);
  });

  it('空任务 → 空分组', () => {
    expect(buildParallelGroups([])).toEqual([]);
  });

  it('循环依赖 → 抛 CyclicDependencyError', () => {
    expect(() =>
      buildParallelGroups([
        task({ id: 't1', dependencies: ['t2'] }),
        task({ id: 't2', dependencies: ['t1'] }),
      ]),
    ).toThrow(/循环依赖/);
  });
});

// ── T5.2 文件冲突检测 ─────────────────────────────────────────

describe('detectGroupConflicts（组内文件冲突）', () => {
  it('同层任务修改同一文件 → 冲突', () => {
    const conflicts = detectGroupConflicts([
      [task({ id: 't1', files: ['src/utils.ts'] }), task({ id: 't2', files: ['src/utils.ts'] })],
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ file: 'src/utils.ts', taskA: 't1', taskB: 't2' });
  });

  it('不同文件 → 无冲突', () => {
    const conflicts = detectGroupConflicts([
      [task({ id: 't1', files: ['src/a.ts'] }), task({ id: 't2', files: ['src/b.ts'] })],
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it('有依赖链的任务对（天然串行）→ 不算冲突', () => {
    const conflicts = detectGroupConflicts([
      [
        task({ id: 't1', files: ['src/a.ts'] }),
        task({ id: 't2', dependencies: ['t1'], files: ['src/a.ts'] }),
      ],
    ]);
    expect(conflicts).toHaveLength(0);
  });
});

// ── T5.2/T5.3 并行执行 ────────────────────────────────────────

describe('runParallelTeams（并行执行 + 上下文隔离 + 冲突串行化）', () => {
  it('无依赖任务并行执行：活跃 coder 峰值 = 2，每任务独立 taskId 上下文', async () => {
    const coder = makeCoder([{ path: 'src/a.ts', content: 'export {};' }]);
    const reviewer = makeReviewer();
    const qa = makeQa();
    const result = await runParallelTeams({
      tasks: [task({ id: 't1' }), task({ id: 't2' })],
      coder,
      reviewer,
      qa,
    });
    expect(result.ok).toBe(true);
    expect(result.parallelized).toBe(true);
    expect(coder.maxActive()).toBe(2); // 真实并发
    expect(result.results.size).toBe(2);
    // 上下文隔离：taskId 唯一且等于任务 id
    const taskIds = coder
      .contexts()
      .map((c) => c.taskId)
      .sort();
    expect(taskIds).toEqual(['t1', 't2']);
    // 每任务独立 artifacts（互不共享）
    const ctx1 = coder.contexts().find((c) => c.taskId === 't1');
    const ctx2 = coder.contexts().find((c) => c.taskId === 't2');
    expect(ctx1?.artifacts).not.toBe(ctx2?.artifacts);
    // 汇总
    expect(result.summary).toContain('全部完成');
    expect(result.conflicts).toHaveLength(0);
  });

  it('有依赖：层间串行（依赖任务不并行）', async () => {
    const coder = makeCoder();
    const result = await runParallelTeams({
      tasks: [
        task({ id: 't1', files: ['a.ts'] }),
        task({ id: 't2', dependencies: ['t1'], files: ['b.ts'] }),
      ],
      coder,
      reviewer: makeReviewer(),
      qa: makeQa(),
    });
    expect(result.ok).toBe(true);
    expect(coder.maxActive()).toBe(1); // t2 依赖 t1 → 串行
    expect(result.groups).toHaveLength(2);
  });

  it('同层同文件冲突 → 整组串行化（maxActive=1）+ 冲突清单提示', async () => {
    const coder = makeCoder();
    const result = await runParallelTeams({
      tasks: [
        task({ id: 't1', files: ['src/utils.ts'] }),
        task({ id: 't2', files: ['src/utils.ts'] }),
      ],
      coder,
      reviewer: makeReviewer(),
      qa: makeQa(),
    });
    expect(result.ok).toBe(true);
    expect(coder.maxActive()).toBe(1); // 冲突 → 串行写盘
    expect(result.conflicts).toHaveLength(1);
    expect(result.summary).toContain('都修改了');
  });

  it('conflictMode=abort → 冲突组不执行，ok=false', async () => {
    const coder = makeCoder();
    const result = await runParallelTeams({
      tasks: [
        task({ id: 't1', files: ['src/utils.ts'] }),
        task({ id: 't2', files: ['src/utils.ts'] }),
      ],
      coder,
      reviewer: makeReviewer(),
      qa: makeQa(),
      conflictMode: 'abort',
    });
    expect(result.ok).toBe(false);
    expect(coder.contexts()).toHaveLength(0); // 未执行任何 coder
    expect(result.summary).toContain('中止');
  });

  it('纯串行链 → parallelized=false + 降级提示', async () => {
    const coder = makeCoder();
    const result = await runParallelTeams({
      tasks: [task({ id: 't1', dependencies: [] }), task({ id: 't2', dependencies: ['t1'] })],
      coder,
      reviewer: makeReviewer(),
      qa: makeQa(),
    });
    expect(result.ok).toBe(true);
    expect(result.parallelized).toBe(false);
    expect(coder.maxActive()).toBe(1);
    expect(result.summary).toContain('无法拆解为可并行任务');
  });

  it('onTaskProgress 每任务每轮回调（taskId 归属正确）', async () => {
    const coder = makeCoder();
    const records: Array<{ taskId: string; phase: string }> = [];
    await runParallelTeams({
      tasks: [task({ id: 't1' }), task({ id: 't2' })],
      coder,
      reviewer: makeReviewer(),
      qa: makeQa(),
      onTaskProgress: (taskId, record) => records.push({ taskId, phase: record.phase }),
    });
    // 每任务 implement/review/qa 三阶段
    expect(records.filter((r) => r.taskId === 't1')).toHaveLength(3);
    expect(records.filter((r) => r.taskId === 't2')).toHaveLength(3);
  });
});

// ── runTeamCommand 集成（T5.1 自然触发 / 显式 --parallel）─────

describe('runTeamCommand 并行分支', () => {
  it('自然语言「同时」→ 自动并行执行两个独立任务', async () => {
    const coder = makeCoder([{ path: 'src/login.ts', content: 'export {};' }]);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '同时修复登录模块的 bug 和重构用户模块的类型定义',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_TWO_TASKS }]),
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(true);
    expect(result.parallel).toBeDefined();
    expect(result.parallel?.parallelized).toBe(true);
    expect(coder.maxActive()).toBe(2);
    expect(result.summary).toContain('全部完成');
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it('显式 --parallel 即使无关键词 → 进入并行分支', async () => {
    const coder = makeCoder([{ path: 'src/login.ts', content: 'export {};' }]);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '修复登录模块的 bug 和重构用户模块',
      parallel: true,
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_TWO_TASKS }]),
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(true);
    expect(result.parallel?.parallelized).toBe(true);
    expect(coder.maxActive()).toBe(2);
  });

  it('并行意图但拆解为串行链 → 降级串行执行 + 提示', async () => {
    const coder = makeCoder([{ path: 'src/a.ts', content: 'export {};' }]);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '同时处理这个串行流程',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_SERIAL }]),
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(true);
    expect(result.parallel?.parallelized).toBe(false);
    expect(coder.maxActive()).toBe(1);
    expect(result.summary).toContain('无法拆解为可并行任务');
  });

  it('并行模式 + 审批拒绝 → 不执行任何 Agent（fail-closed）', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const coder = makeCoder();
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '同时修复登录模块的 bug 和重构用户模块',
      parallel: true,
      client: new FakeModel([{ content: DECOMPOSE_TWO_TASKS }]),
      confirm: async () => false,
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('未确认');
    expect(coder.contexts()).toHaveLength(0);
  });

  it('并行模式单任务（无并行度）→ 正常执行，parallelized=false', async () => {
    const single = JSON.stringify([
      {
        id: 't1',
        description: '实现 TODO',
        agent: 'coder',
        dependencies: [],
        files: ['src/todo.ts'],
      },
    ]);
    const coder = makeCoder([{ path: 'src/todo.ts', content: 'export {};' }]);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      parallel: true,
      autoApprove: true,
      client: new FakeModel([{ content: single }]),
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(true);
    expect(result.parallel?.parallelized).toBe(false);
    expect(coder.maxActive()).toBe(1);
  });
});

// ── 进度文案（T5.3 i18n）──────────────────────────────────────

describe('formatTeamProgress 并行文案', () => {
  it('loop-attempt 带 taskId → 任务前缀；parallel-task → 完成/失败', () => {
    expect(
      formatTeamProgress({
        kind: 'loop-attempt',
        attempt: 1,
        total: 5,
        phase: 'implement',
        taskId: 't1',
      }),
    ).toBe('🔁 任务 t1 第 1/5 轮（实现）');
    expect(formatTeamProgress({ kind: 'parallel-task', taskId: 't1', ok: true })).toBe(
      '⚡ 任务 t1 并行完成',
    );
    expect(formatTeamProgress({ kind: 'parallel-task', taskId: 't2', ok: false })).toBe(
      '❌ 任务 t2 并行失败',
    );
  });
});
