/**
 * team 命令测试（v3.1 M5 / T5.1）。
 *
 * 覆盖验收标准：
 * - 拆解：FakeModel 输出 JSON Task[] → formatTaskList 展示清单；
 * - --dry-run：仅输出拆解清单，不执行任何 Agent；
 * - 审批拒绝：confirm=false → 取消且不写盘（fail-closed）；
 * - 对抗性闭环：coder 实现 → reviewer approve → qa 全绿 → 成功聚合；
 * - 闭环超限（QA 连续失败 ≥ MAX_LOOP_ATTEMPTS=5）→ 回滚兜底 + 快照清理。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QaReport } from '../../src/agents';
import {
  formatTaskList,
  formatTeamProgress,
  runTeamCommand,
  type TeamProgress,
} from '../../src/cli/team';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import type { CoderLike, QaLike, ReviewerLike } from '../../src/orchestrator';

/** 拆解输出（模型 streamChat 单次返回 JSON Task[]）。 */
const DECOMPOSE_JSON = JSON.stringify([
  {
    id: 't1',
    description: '实现一个 TODO 应用',
    agent: 'coder',
    dependencies: [],
    files: ['src/todo.ts'],
  },
]);

/** 脚本式 FakeModel：按序输出拆解 JSON（team 内仅拆解调用一次模型）。 */
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

/** 抛网络错误的 client（v3.2 M3 / T3.3：模拟 API 超时 / fetch 失败，区分于格式解析失败）。 */
class NetworkErrorModel implements ModelClient {
  // biome-ignore lint/correctness/useYield: 故意不 yield —— 模拟 API 调用失败，首次迭代即抛错、永不产出（区别于 FakeModel 正常流式）
  async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
    // 模拟 API 调用失败：首次迭代即抛错、永不产出 —— 故意不 yield（区别于 FakeModel 正常流式）
    throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443');
  }
}

/** 构造 Fake coder（记录调用；可注入 files）。 */
function makeCoder(files: Array<{ path: string; content: string }> = []): CoderLike & {
  calls: number;
} {
  const coder = {
    calls: 0,
    async execute() {
      coder.calls += 1;
      return { files };
    },
  };
  return coder;
}

/** 构造 Fake reviewer（可注入 action）。 */
function makeReviewer(action: 'approve' | 'reject' = 'approve'): ReviewerLike & { calls: number } {
  const reviewer = {
    calls: 0,
    async execute() {
      reviewer.calls += 1;
      return {
        action,
        issues: [],
        summary: action === 'approve' ? '通过，进入 QA' : '打回 Coder 修复',
        testPassed: null,
      };
    },
  };
  return reviewer;
}

/** 构造 Fake qa（可注入 passed）。 */
function makeQa(passed = true): QaLike & { calls: number } {
  const qa = {
    calls: 0,
    async execute(): Promise<QaReport> {
      qa.calls += 1;
      return {
        passed,
        testFiles: passed ? 1 : 0,
        testCases: passed ? 1 : 0,
        failedItems: passed ? [] : [{ file: 'src/todo.test.ts', testName: '测试', error: '失败' }],
        timedOut: false,
        summary: passed ? '全部通过' : '测试失败',
        durationMs: 1,
      };
    },
  };
  return qa;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'team-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('formatTaskList（拆解清单展示）', () => {
  it('列出任务 id / 负责人 / 描述 / 依赖 / 文件', () => {
    const text = formatTaskList([
      {
        id: 't1',
        description: '实现 TODO',
        agent: 'coder',
        dependencies: [],
        files: ['src/todo.ts'],
      },
    ]);
    expect(text).toContain('t1');
    expect(text).toContain('[coder]');
    expect(text).toContain('实现 TODO');
    expect(text).toContain('依赖: 无');
    expect(text).toContain('src/todo.ts');
  });

  it('空清单 → 提示', () => {
    expect(formatTaskList([])).toContain('为空');
  });
});

describe('runTeamCommand', () => {
  it('--dry-run：仅输出拆解清单，不执行任何 Agent', async () => {
    const coder = makeCoder();
    const reviewer = makeReviewer();
    const qa = makeQa();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      dryRun: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      agents: { coder, reviewer, qa },
    });
    expect(result.ok).toBe(true);
    expect(result.tasks).toHaveLength(1);
    expect(result.summary).toContain('dry-run');
    expect(coder.calls).toBe(0);
    expect(reviewer.calls).toBe(0);
    expect(qa.calls).toBe(0);
    // 拆解清单被输出
    const out = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('任务拆解');
    expect(out).toContain('[coder]');
    stdout.mockRestore();
  });

  it('审批拒绝 → 取消且不执行任何 Agent（fail-closed）', async () => {
    // 模拟 TTY（非 TTY 时 team 会 process.exit）
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const coder = makeCoder();
    const reviewer = makeReviewer();
    const qa = makeQa();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      confirm: async () => false,
      agents: { coder, reviewer, qa },
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('未确认');
    expect(coder.calls).toBe(0);
    expect(reviewer.calls).toBe(0);
    expect(qa.calls).toBe(0);
    stdout.mockRestore();
  });

  it('闭环成功：coder 实现 → reviewer approve → qa 全绿 → 聚合工件', async () => {
    const coder = makeCoder([{ path: 'src/todo.ts', content: 'export const todo = 1;' }]);
    const reviewer = makeReviewer('approve');
    const qa = makeQa(true);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      agents: { coder, reviewer, qa },
    });
    expect(result.ok).toBe(true);
    expect(coder.calls).toBe(1);
    expect(reviewer.calls).toBe(1);
    expect(qa.calls).toBe(1);
    expect(result.loop?.attempts).toBe(1);
    // 工件包含 code / review-result / test-report
    const types = result.artifacts.map((a) => a.type);
    expect(types).toContain('code');
    expect(types).toContain('review-result');
    expect(types).toContain('test-report');
    // 闭环成功 → 快照已提交清理（taskId 子目录删除；snapshots 父目录保留供 list/clean）
    const snapshotsRoot = path.join(tmp, '.concertoai', 'snapshots');
    const left = existsSync(snapshotsRoot)
      ? readdirSync(snapshotsRoot).filter((f) => f.startsWith('team-'))
      : [];
    expect(left).toEqual([]);
  });

  it('闭环超限（QA 连续失败 ≥ 5 次）→ 回滚兜底 + 快照清理', async () => {
    const coder = makeCoder([{ path: 'src/todo.ts', content: 'export const todo = 1;' }]);
    const reviewer = makeReviewer('approve');
    const qa = makeQa(false); // QA 永远失败 → 循环修复直到超限
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      agents: { coder, reviewer, qa },
    });
    expect(result.ok).toBe(false);
    expect(result.loop?.ok).toBe(false);
    expect(result.loop?.attempts).toBe(5); // MAX_LOOP_ATTEMPTS
    expect(result.summary).toContain('未收敛');
    // onRollback → SnapshotManager.rollback 清理 taskId 快照目录
    const snapshotsRoot = path.join(tmp, '.concertoai', 'snapshots');
    const left = existsSync(snapshotsRoot)
      ? readdirSync(snapshotsRoot).filter((f) => f.startsWith('team-'))
      : [];
    expect(left).toEqual([]);
  });

  it('需求拆解失败（模型输出非 JSON）→ 中文错误且不执行 Agent', async () => {
    const coder = makeCoder();
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      autoApprove: true,
      client: new FakeModel([{ content: '不是 JSON' }]),
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('需求拆解失败');
    expect(coder.calls).toBe(0);
  });

  // ── diagnostics（v3.2 M3 / T3.3：区分格式解析失败 vs 网络超时）──

  it('拆解 JSON 解析失败 → diagnostics.kind=parse + rawOutput 原文（截断 ≤500）', async () => {
    const coder = makeCoder();
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      autoApprove: true,
      client: new FakeModel([{ content: '不是 JSON 输出' }]),
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics?.kind).toBe('parse');
    expect(result.diagnostics?.rawOutput).toContain('不是 JSON 输出');
    expect(result.diagnostics?.rawOutput?.length).toBeLessThanOrEqual(500);
    expect(coder.calls).toBe(0);
  });

  it('模型调用网络错误 → diagnostics.kind=network 且无 rawOutput', async () => {
    const coder = makeCoder();
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      autoApprove: true,
      client: new NetworkErrorModel(),
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics?.kind).toBe('network');
    expect(result.diagnostics?.rawOutput).toBeUndefined();
    expect(result.summary).toContain('模型调用错误');
    expect(coder.calls).toBe(0);
  });

  it('拆解成功 → 无 diagnostics 字段', async () => {
    const coder = makeCoder([{ path: 'src/todo.ts', content: 'export const todo = 1;' }]);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      agents: { coder, reviewer: makeReviewer(), qa: makeQa() },
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toBeUndefined();
  });

  // ── 进度回调（v3.2 M4 / T4.1：长任务中间消息推送）──

  it('onProgress 回调序列：decomposed → loop-attempt×3（implement/review/qa）→ done', async () => {
    const progress: TeamProgress[] = [];
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      agents: {
        coder: makeCoder([{ path: 'src/todo.ts', content: 'export const todo = 1;' }]),
        reviewer: makeReviewer('approve'),
        qa: makeQa(true),
      },
      onProgress: (p) => progress.push(p),
    });
    expect(result.ok).toBe(true);
    expect(progress.map((p) => p.kind)).toEqual([
      'decomposed',
      'loop-attempt',
      'loop-attempt',
      'loop-attempt',
      'done',
    ]);
    const first = progress[0];
    if (first?.kind === 'decomposed') {
      expect(first.taskCount).toBe(1);
    }
    const phases = progress
      .filter(
        (p): p is Extract<TeamProgress, { kind: 'loop-attempt' }> => p.kind === 'loop-attempt',
      )
      .map((p) => p.phase);
    expect(phases).toEqual(['implement', 'review', 'qa']);
    const done = progress.at(-1);
    if (done?.kind === 'done') {
      expect(done.ok).toBe(true);
    }
  });

  it('formatTeamProgress：拆解/轮次/完成中文文案', () => {
    expect(formatTeamProgress({ kind: 'decomposed', taskCount: 2 })).toBe('📋 已拆解 2 个任务');
    expect(
      formatTeamProgress({ kind: 'loop-attempt', attempt: 1, total: 5, phase: 'review' }),
    ).toBe('🔁 第 1/5 轮（审查）');
    expect(formatTeamProgress({ kind: 'done', ok: false })).toContain('未成功');
  });

  it('审批拒绝 → done(ok:false) 收尾（fail-closed 进度一致）', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const progress: TeamProgress[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      confirm: async () => false,
      agents: { coder: makeCoder(), reviewer: makeReviewer(), qa: makeQa() },
      onProgress: (p) => progress.push(p),
    });
    expect(result.ok).toBe(false);
    expect(progress.map((p) => p.kind)).toEqual(['decomposed', 'done']);
    const done = progress.at(-1);
    if (done?.kind === 'done') {
      expect(done.ok).toBe(false);
    }
    stdout.mockRestore();
  });

  // ── P5 收尾：silent 模式（/orchestrate 库调用不污染 TUI）──

  it('silent=true → 不写 stdout/stderr，结果仅经返回值承载', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const progress: TeamProgress[] = [];
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO',
      silent: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      confirm: async () => true,
      agents: {
        coder: makeCoder([{ path: 'src/todo.ts', content: 'export const todo = 1;' }]),
        reviewer: makeReviewer('approve'),
        qa: makeQa(true),
      },
      onProgress: (p) => progress.push(p),
    });
    expect(result.ok).toBe(true);
    // 进度回调仍工作（/orchestrate 靠它推送聊天消息）
    expect(progress.length).toBeGreaterThan(0);
    // 但 stdout/stderr 零直写（不污染 TUI）
    expect(stdout.mock.calls).toHaveLength(0);
    expect(stderr.mock.calls).toHaveLength(0);
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
