/**
 * team CLI 全链路 E2E（v3.1 M6 / T6.1 E2E-1）。
 *
 * 端到端串联（CLI 层 runTeamCommand + 真实磁盘）：
 * - FakeModel 拆解任务 → 展示确认（autoApprove）→ 对抗性闭环（真实写盘 coder + approve reviewer + passed qa）→ 文件落地 + 快照提交清理；
 * - 闭环超限（QA 连续失败）→ onRollback → 事务回滚 → 新增文件删除（恢复任务前状态）。
 *
 * 依赖：M5（team.ts）+ v3.0（runTeamLoop / SnapshotManager / agents）。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QaReport } from '../../src/agents';
import { runTeamCommand, type TeamProgress } from '../../src/cli/team';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import type { CoderLike, QaLike, ReviewerLike } from '../../src/orchestrator';

/** 拆解输出（单任务 coder，files 指向待写文件）。 */
const DECOMPOSE_JSON = JSON.stringify([
  {
    id: 't1',
    description: '实现 TODO 模块',
    agent: 'coder',
    dependencies: [],
    files: ['src/todo.ts'],
  },
]);

/** FakeModel：流式返回拆解 JSON。 */
class FakeModel implements ModelClient {
  constructor(private readonly script: Array<{ content?: string }>) {}

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const step = this.script.shift();
    if (step === undefined) throw new Error('FakeModel 脚本耗尽');
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

/** 真实写盘 coder：execute 时把文件写入 cwd（模拟 CoderAgent + DiskFileWriter）。 */
function makeDiskCoder(
  cwd: string,
  files: Array<{ path: string; content: string }>,
): CoderLike & {
  calls: number;
} {
  const coder = {
    calls: 0,
    async execute() {
      coder.calls += 1;
      for (const f of files) {
        const full = path.join(cwd, f.path);
        const dir = path.dirname(full);
        // 同步建目录 + 写盘（简化 E2E；生产走 DiskFileWriter）
        if (!existsSync(dir)) {
          const { mkdirSync } = require('node:fs');
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(full, f.content, 'utf8');
      }
      return { files };
    },
  };
  return coder;
}

/** Fake reviewer（approve）。 */
function makeApproveReviewer(): ReviewerLike {
  return {
    async execute() {
      return {
        action: 'approve',
        issues: [],
        summary: '审查通过',
        testPassed: null,
      };
    },
  };
}

/** Fake qa（passed 可注入）。 */
function makeQa(passed: boolean): QaLike {
  return {
    async execute(): Promise<QaReport> {
      return {
        passed,
        testFiles: 1,
        testCases: 1,
        failedItems: passed ? [] : [{ file: 'src/todo.test.ts', testName: '测试', error: '失败' }],
        timedOut: false,
        durationMs: 1,
        summary: passed ? '通过' : '失败',
      };
    },
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'e2e-team-cli-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 快照目录下残留的 team- 子目录。 */
function leftoverTeamSnapshots(): string[] {
  const root = path.join(tmp, '.concertoai', 'snapshots');
  return existsSync(root) ? readdirSync(root).filter((f) => f.startsWith('team-')) : [];
}

describe('E2E：team CLI 全链路（拆解 → 闭环 → 真实写盘 → 聚合）', () => {
  it('FakeModel 拆解 + approve reviewer + passed qa → 文件落地 + 工件聚合 + 快照清理', async () => {
    const files = [{ path: 'src/todo.ts', content: 'export const todo = 1;\n' }];
    const coder = makeDiskCoder(tmp, files);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO 模块',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      agents: { coder, reviewer: makeApproveReviewer(), qa: makeQa(true) },
    });

    expect(result.ok).toBe(true);
    expect(coder.calls).toBe(1);
    // 文件真实落地
    expect(existsSync(path.join(tmp, 'src/todo.ts'))).toBe(true);
    // 工件聚合：code / review-result / test-report
    const types = result.artifacts.map((a) => a.type);
    expect(types).toContain('code');
    expect(types).toContain('review-result');
    expect(types).toContain('test-report');
    // 闭环成功 → 快照提交清理
    expect(leftoverTeamSnapshots()).toEqual([]);
  });

  it('onProgress 回调序列 E2E（v3.2 M6 / T6.1）：decomposed → loop-attempt×3 → done，伴随真实写盘', async () => {
    const files = [{ path: 'src/todo.ts', content: 'export const todo = 1;\n' }];
    const coder = makeDiskCoder(tmp, files);
    const progress: TeamProgress[] = [];
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO 模块',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      agents: { coder, reviewer: makeApproveReviewer(), qa: makeQa(true) },
      // T4.1 进度回调：长任务中间消息推送（CLI stdout / chat 消息流共用）
      onProgress: (p) => progress.push(p),
    });

    expect(result.ok).toBe(true);
    // 文件真实落地（进度全链路伴随真实执行，非纯 mock）
    expect(existsSync(path.join(tmp, 'src/todo.ts'))).toBe(true);
    // 进度序列：拆解 → 1 轮闭环（implement/review/qa）→ 收尾
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

  it('闭环超限（QA 连续失败）→ onRollback 事务回滚 → 新增文件删除（恢复任务前状态）', async () => {
    // 任务前：src/todo.ts 不存在（新增文件场景）
    const files = [{ path: 'src/todo.ts', content: 'export const todo = 1;\n' }];
    const coder = makeDiskCoder(tmp, files);
    const result = await runTeamCommand({
      cwd: tmp,
      apiKey: 'sk-test',
      task: '实现 TODO 模块',
      autoApprove: true,
      client: new FakeModel([{ content: DECOMPOSE_JSON }]),
      agents: { coder, reviewer: makeApproveReviewer(), qa: makeQa(false) }, // QA 永远失败
    });

    expect(result.ok).toBe(false);
    expect(result.loop?.ok).toBe(false);
    expect(result.loop?.attempts).toBe(5); // MAX_LOOP_ATTEMPTS
    // 事务回滚：新增文件被删除（恢复到任务前不存在状态）
    expect(existsSync(path.join(tmp, 'src/todo.ts'))).toBe(false);
    // 回滚成功 → 快照清理
    expect(leftoverTeamSnapshots()).toEqual([]);
  });
});
