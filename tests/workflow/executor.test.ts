/**
 * 工作流执行引擎测试（v4.0 M2 T2.3）。
 *
 * 覆盖：DAG 依赖排序 / 并行执行 / 审批节点 / 进度推送 / 失败恢复
 * （retry/skip/abort）/ 整体快照回滚 / 全部成功 commit。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SnapshotManager } from '../../src/orchestrator/transaction';
import type { CommandRunner, RecoveryChoice } from '../../src/workflow/executor';
import { runWorkflow } from '../../src/workflow/executor';
import type { Workflow } from '../../src/workflow/types';

const abort = async (): Promise<RecoveryChoice> => 'abort';
const retryChoice = async (): Promise<RecoveryChoice> => 'retry';
const skipChoice = async (): Promise<RecoveryChoice> => 'skip';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-workflow-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 简易 fake runner：按命令名分派 ok/fail。 */
function fakeRunner(
  handler: (
    cmd: string,
  ) => { ok: boolean; stderr?: string } | Promise<{ ok: boolean; stderr?: string }>,
): CommandRunner {
  return async (cmd) => {
    const out = await handler(cmd);
    return { ok: out.ok, stdout: '', stderr: out.stderr ?? '' };
  };
}

describe('runWorkflow（T2.3 执行引擎）', () => {
  it('串行依赖排序正确：test 在 build 之后执行', async () => {
    const order: string[] = [];
    const wf: Workflow = {
      name: 'dep',
      steps: [
        { name: 'test', run: 'test', depends: ['build'] },
        { name: 'build', run: 'build' },
      ],
    };
    const result = await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async (cmd) => {
        order.push(cmd);
        return { ok: true };
      }),
    });
    expect(result.ok).toBe(true);
    expect(order).toEqual(['build', 'test']);
  });

  it('无依赖步骤并行执行（并发 > 1）', async () => {
    let active = 0;
    let maxActive = 0;
    const wf: Workflow = {
      name: 'parallel',
      steps: [
        { name: 'a', run: 'a' },
        { name: 'b', run: 'b' },
      ],
    };
    const result = await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { ok: true };
      }),
    });
    expect(result.ok).toBe(true);
    expect(maxActive).toBeGreaterThanOrEqual(2);
  });

  it('审批节点：require: approval 步骤等待确认；拒绝 → fail-closed', async () => {
    const executed: string[] = [];
    const wf: Workflow = {
      name: 'approve',
      steps: [
        { name: 'lint', run: 'lint' },
        { name: 'publish', run: 'publish', depends: ['lint'], require: 'approval' },
      ],
    };
    let approvalCalled = false;
    const result = await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async (cmd) => {
        executed.push(cmd);
        return { ok: true };
      }),
      requestApproval: async () => {
        approvalCalled = true;
        return false; // 拒绝
      },
      onFailure: abort,
    });
    expect(approvalCalled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('publish');
    // publish 命令未执行
    expect(executed).not.toContain('publish');
  });

  it('审批节点：批准 → 继续执行', async () => {
    const executed: string[] = [];
    const wf: Workflow = {
      name: 'approve-ok',
      steps: [{ name: 'publish', run: 'publish', require: 'approval' }],
    };
    const result = await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async (cmd) => {
        executed.push(cmd);
        return { ok: true };
      }),
      requestApproval: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(executed).toEqual(['publish']);
  });

  it('进度推送：running / done 事件序列（onProgress）', async () => {
    const progress: string[] = [];
    const wf: Workflow = {
      name: 'progress',
      steps: [
        { name: 'a', run: 'a' },
        { name: 'b', run: 'b', depends: ['a'] },
      ],
    };
    await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async () => ({ ok: true })),
      onProgress: (p) => {
        if (p.stepName !== '') {
          progress.push(`${p.state}:${p.stepName}`);
        }
      },
    });
    expect(progress).toContain('running:a');
    expect(progress).toContain('running:b');
  });

  it('失败恢复：retry 后成功（已完成步骤不重跑）', async () => {
    const executed: string[] = [];
    let flakyAttempts = 0;
    const wf: Workflow = {
      name: 'retry',
      steps: [
        { name: 'ok', run: 'ok' },
        { name: 'flaky', run: 'flaky', depends: ['ok'] },
      ],
    };
    const result = await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async (cmd) => {
        executed.push(cmd);
        if (cmd === 'flaky') {
          flakyAttempts += 1;
          return flakyAttempts < 2 ? { ok: false, stderr: 'flaky fail' } : { ok: true };
        }
        return { ok: true };
      }),
      onFailure: retryChoice,
    });
    expect(result.ok).toBe(true);
    // flaky 执行 2 次（首次失败 + 重试）；ok 步骤只执行 1 次（不重跑已完成）
    expect(executed.filter((c) => c === 'flaky')).toHaveLength(2);
    expect(executed.filter((c) => c === 'ok')).toHaveLength(1);
  });

  it('失败恢复：skip 后下游继续执行', async () => {
    const executed: string[] = [];
    const wf: Workflow = {
      name: 'skip',
      steps: [
        { name: 'fail', run: 'fail' },
        { name: 'after', run: 'after', depends: ['fail'] },
      ],
    };
    const result = await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async (cmd) => {
        if (cmd === 'fail') {
          return { ok: false, stderr: 'boom' };
        }
        executed.push(cmd);
        return { ok: true };
      }),
      onFailure: skipChoice,
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toContain('fail');
    expect(executed).toContain('after');
  });

  it('失败放弃（abort）→ 整体快照回滚，文件恢复原状', async () => {
    const file = path.join(tmp, 'a.txt');
    writeFileSync(file, 'original', 'utf8');
    const wf: Workflow = {
      name: 'rollback',
      steps: [
        { name: 'write', run: 'write', files: ['a.txt'] },
        { name: 'fail', run: 'fail', depends: ['write'] },
      ],
    };
    const snapshots = new SnapshotManager(tmp);
    const result = await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async (cmd) => {
        if (cmd === 'write') {
          writeFileSync(file, 'changed', 'utf8');
          return { ok: true };
        }
        return { ok: false, stderr: 'boom' };
      }),
      onFailure: abort,
      snapshots,
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('fail');
    // 整体回滚：文件恢复
    expect(readFileSync(file, 'utf8')).toBe('original');
    // 快照已清理
    expect(await snapshots.list()).toEqual([]);
  });

  it('全部成功 → 快照 commit（无残留）', async () => {
    const file = path.join(tmp, 'a.txt');
    writeFileSync(file, 'original', 'utf8');
    const wf: Workflow = {
      name: 'commit',
      steps: [{ name: 'write', run: 'write', files: ['a.txt'] }],
    };
    const snapshots = new SnapshotManager(tmp);
    const result = await runWorkflow(wf, {
      cwd: tmp,
      runCommand: fakeRunner(async () => {
        writeFileSync(file, 'new', 'utf8');
        return { ok: true };
      }),
      snapshots,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(await snapshots.list()).toEqual([]);
  });

  it('循环依赖 → 抛错（CyclicDependencyError）', async () => {
    const wf: Workflow = {
      name: 'cycle',
      steps: [
        { name: 'a', run: 'a', depends: ['b'] },
        { name: 'b', run: 'b', depends: ['a'] },
      ],
    };
    await expect(
      runWorkflow(wf, { cwd: tmp, runCommand: fakeRunner(async () => ({ ok: true })) }),
    ).rejects.toThrow('循环依赖');
  });
});
