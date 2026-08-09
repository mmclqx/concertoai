/**
 * 任务调度器测试（v3.0 M2 / T2.2，DAG 工作流引擎）。
 *
 * 覆盖验收标准：
 * - 拓扑排序输出执行顺序（含依赖不存在报错、循环依赖检测返回环路径）；
 * - 无依赖任务并行执行（并发池，默认并发 3，可自定义）；
 * - 单个任务失败 → 标记 failed，依赖它的任务级联跳过（含传递跳过）；
 * - 重试（最多 2 次，指数退避）；
 * - 文件级冲突检测：两个任务修改同一文件 → 'error' 报冲突 / 'serialize' 串行化。
 */
import { describe, expect, it } from 'vitest';
import {
  CyclicDependencyError,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  detectFileConflicts,
  hasDependencyPath,
  type SchedulerTask,
  TaskScheduler,
  topologicalSort,
} from '../../src/orchestrator';

// ── 工具 ──────────────────────────────────────────────────────

function makeTask(
  id: string,
  run: () => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string },
  options: { dependencies?: string[]; files?: string[] } = {},
): SchedulerTask {
  return { id, dependencies: options.dependencies ?? [], files: options.files, run };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 拓扑排序 ──────────────────────────────────────────────────

describe('topologicalSort（拓扑排序 + 环检测）', () => {
  it('线性链按依赖顺序输出：a → b → c', () => {
    const tasks = [
      makeTask('c', () => ({ ok: true }), { dependencies: ['b'] }),
      makeTask('a', () => ({ ok: true })),
      makeTask('b', () => ({ ok: true }), { dependencies: ['a'] }),
    ];
    const { order, cycle } = topologicalSort(tasks);
    expect(cycle).toBeUndefined();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    expect(order).toHaveLength(3);
  });

  it('无依赖任务按输入顺序输出', () => {
    const tasks = [
      makeTask('x', () => ({ ok: true })),
      makeTask('y', () => ({ ok: true })),
      makeTask('z', () => ({ ok: true })),
    ];
    const { order } = topologicalSort(tasks);
    expect(order).toEqual(['x', 'y', 'z']);
  });

  it('依赖不存在的任务抛错', () => {
    const tasks = [makeTask('a', () => ({ ok: true }), { dependencies: ['ghost'] })];
    expect(() => topologicalSort(tasks)).toThrow(/依赖不存在的任务: ghost/);
  });

  it('任务 ID 重复抛错', () => {
    const tasks = [makeTask('a', () => ({ ok: true })), makeTask('a', () => ({ ok: true }))];
    expect(() => topologicalSort(tasks)).toThrow(/ID 重复/);
  });

  it('循环依赖返回环路径（a → b → c → a）', () => {
    const tasks = [
      makeTask('a', () => ({ ok: true }), { dependencies: ['c'] }),
      makeTask('b', () => ({ ok: true }), { dependencies: ['a'] }),
      makeTask('c', () => ({ ok: true }), { dependencies: ['b'] }),
    ];
    const { order, cycle } = topologicalSort(tasks);
    expect(order).toHaveLength(0); // 全部在环中，无拓扑序
    expect(cycle).toBeDefined();
    // 环路径包含 a→b→c→a 的闭环
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(cycle?.length).toBe(4);
  });

  it('部分环：环外任务正常排序，环内任务返回环路径', () => {
    const tasks = [
      makeTask('root', () => ({ ok: true })),
      makeTask('a', () => ({ ok: true }), { dependencies: ['root', 'b'] }),
      makeTask('b', () => ({ ok: true }), { dependencies: ['a'] }),
    ];
    const { order, cycle } = topologicalSort(tasks);
    expect(order).toEqual(['root']);
    expect(cycle).toBeDefined();
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
  });
});

// ── 依赖路径查询 / 文件冲突 ──────────────────────────────────

describe('detectFileConflicts（文件级冲突检测）', () => {
  it('两个任务修改同一文件且无依赖 → 冲突', () => {
    const tasks = [
      makeTask('a', () => ({ ok: true }), { files: ['src/a.ts'] }),
      makeTask('b', () => ({ ok: true }), { files: ['src/a.ts'] }),
    ];
    const conflicts = detectFileConflicts(tasks);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.file).toBe('src/a.ts');
    expect(conflicts[0]?.taskA).toBe('a');
    expect(conflicts[0]?.taskB).toBe('b');
  });

  it('有依赖链的任务修改同一文件 → 不冲突（天然串行）', () => {
    const tasks = [
      makeTask('a', () => ({ ok: true }), { files: ['src/a.ts'] }),
      makeTask('b', () => ({ ok: true }), { dependencies: ['a'], files: ['src/a.ts'] }),
    ];
    expect(detectFileConflicts(tasks)).toEqual([]);
  });

  it('间接依赖同样不算冲突', () => {
    const tasks = [
      makeTask('a', () => ({ ok: true }), { files: ['src/a.ts'] }),
      makeTask('b', () => ({ ok: true }), { dependencies: ['a'] }),
      makeTask('c', () => ({ ok: true }), { dependencies: ['b'], files: ['src/a.ts'] }),
    ];
    expect(detectFileConflicts(tasks)).toEqual([]);
    expect(hasDependencyPath(tasks, 'c', 'a')).toBe(true);
    expect(hasDependencyPath(tasks, 'a', 'c')).toBe(false);
  });

  it('不同文件不冲突；同一任务多文件各自检测', () => {
    const tasks = [
      makeTask('a', () => ({ ok: true }), { files: ['src/x.ts'] }),
      makeTask('b', () => ({ ok: true }), { files: ['src/y.ts'] }),
    ];
    expect(detectFileConflicts(tasks)).toEqual([]);
  });
});

// ── 调度：并行执行 ───────────────────────────────────────────

describe('TaskScheduler 并行执行（并发池）', () => {
  it('默认并发 3：无依赖任务并发峰值 ≤ 3 且 > 1', async () => {
    expect(DEFAULT_CONCURRENCY).toBe(3);
    const peak = { value: 0 };
    let concurrent = 0;
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTask(`t${i}`, async () => {
        concurrent += 1;
        peak.value = Math.max(peak.value, concurrent);
        await delay(10);
        concurrent -= 1;
        return { ok: true };
      }),
    );
    const scheduler = new TaskScheduler();
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(true);
    expect(result.failed.size).toBe(0);
    expect(result.completed.size).toBe(10);
    expect(peak.value).toBeGreaterThan(1);
    expect(peak.value).toBeLessThanOrEqual(3);
  });

  it('自定义并发 1：完全串行执行（峰值 = 1）', async () => {
    const peak = { value: 0 };
    let concurrent = 0;
    const tasks = Array.from({ length: 4 }, (_, i) =>
      makeTask(`t${i}`, async () => {
        concurrent += 1;
        peak.value = Math.max(peak.value, concurrent);
        await delay(5);
        concurrent -= 1;
        return { ok: true };
      }),
    );
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(true);
    expect(peak.value).toBe(1);
  });

  it('依赖约束：下游任务在上游完成后才执行', async () => {
    const orderLog: string[] = [];
    const tasks = [
      makeTask('a', async () => {
        await delay(15);
        orderLog.push('a');
        return { ok: true };
      }),
      makeTask('b', async () => {
        orderLog.push('b');
        return { ok: true };
      }),
      makeTask(
        'c',
        async () => {
          orderLog.push('c');
          return { ok: true };
        },
        { dependencies: ['a'] },
      ),
    ];
    const scheduler = new TaskScheduler();
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(true);
    // c 依赖 a，a 完成后 c 才执行；b 无依赖可与 a 并行
    const indexA = orderLog.indexOf('a');
    const indexC = orderLog.indexOf('c');
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexC).toBeGreaterThan(indexA);
  });

  it('schedule 返回拓扑序 order', async () => {
    const tasks = [
      makeTask('c', () => ({ ok: true }), { dependencies: ['a', 'b'] }),
      makeTask('a', () => ({ ok: true })),
      makeTask('b', () => ({ ok: true })),
    ];
    const scheduler = new TaskScheduler();
    const result = await scheduler.schedule(tasks);
    expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('c'));
    expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('c'));
  });

  it('空任务数组 → ok 且 order 为空', async () => {
    const scheduler = new TaskScheduler();
    const result = await scheduler.schedule([]);
    expect(result.ok).toBe(true);
    expect(result.order).toEqual([]);
    expect(result.completed.size).toBe(0);
  });
});

// ── 调度：失败与级联跳过 ─────────────────────────────────────

describe('失败与级联跳过', () => {
  it('任务失败 → failed 记录错误信息', async () => {
    const tasks = [
      makeTask('bad', () => ({ ok: false, error: '编译失败' })),
      makeTask('good', () => ({ ok: true })),
    ];
    const scheduler = new TaskScheduler({ retryBaseDelayMs: 0 });
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(false);
    expect(result.failed.get('bad')).toBe('编译失败');
    expect(result.completed.get('good')).toEqual({ ok: true });
  });

  it('任务抛异常 → 视为失败并记录异常消息', async () => {
    const tasks = [
      makeTask('boom', () => {
        throw new Error('运行时爆炸');
      }),
    ];
    const scheduler = new TaskScheduler({ retryBaseDelayMs: 0 });
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(false);
    expect(result.failed.get('boom')).toBe('运行时爆炸');
  });

  it('依赖失败的任务被跳过（skipped）', async () => {
    const tasks = [
      makeTask('a', () => ({ ok: false, error: 'a 失败' })),
      makeTask('b', () => ({ ok: true }), { dependencies: ['a'] }),
      makeTask('c', () => ({ ok: true })),
    ];
    const scheduler = new TaskScheduler({ retryBaseDelayMs: 0 });
    const result = await scheduler.schedule(tasks);
    expect(result.failed.get('a')).toBe('a 失败');
    expect(result.skipped).toContain('b');
    expect(result.completed.get('c')).toEqual({ ok: true }); // 无依赖任务不受影响
    expect(result.completed.has('b')).toBe(false);
  });

  it('级联传递：a 失败 → b 跳过 → c（依赖 b）也跳过', async () => {
    const tasks = [
      makeTask('a', () => ({ ok: false, error: '根因' })),
      makeTask('b', () => ({ ok: true }), { dependencies: ['a'] }),
      makeTask('c', () => ({ ok: true }), { dependencies: ['b'] }),
    ];
    const scheduler = new TaskScheduler({ retryBaseDelayMs: 0 });
    const result = await scheduler.schedule(tasks);
    expect(result.skipped).toEqual(expect.arrayContaining(['b', 'c']));
    expect(result.completed.size).toBe(0);
  });

  it('循环依赖调度时抛 CyclicDependencyError（携带环路径）', async () => {
    const tasks = [
      makeTask('a', () => ({ ok: true }), { dependencies: ['b'] }),
      makeTask('b', () => ({ ok: true }), { dependencies: ['a'] }),
    ];
    const scheduler = new TaskScheduler();
    let caught: CyclicDependencyError | undefined;
    try {
      await scheduler.schedule(tasks);
    } catch (err) {
      caught = err as CyclicDependencyError;
    }
    expect(caught).toBeInstanceOf(CyclicDependencyError);
    expect(caught?.cycle).toBeDefined();
    expect(caught?.message).toContain('循环依赖');
  });
});

// ── 调度：重试 ────────────────────────────────────────────────

describe('重试（最多 2 次，指数退避）', () => {
  it('失败 1 次后成功（重试恢复）', async () => {
    expect(DEFAULT_MAX_RETRIES).toBe(2);
    let calls = 0;
    const tasks = [
      makeTask('flaky', async () => {
        calls += 1;
        if (calls < 2) {
          return { ok: false, error: '暂时失败' };
        }
        return { ok: true };
      }),
    ];
    const scheduler = new TaskScheduler({ retryBaseDelayMs: 0 });
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(result.completed.get('flaky')).toEqual({ ok: true });
  });

  it('重试耗尽（共 3 次尝试）→ failed', async () => {
    let calls = 0;
    const tasks = [
      makeTask('always-fail', async () => {
        calls += 1;
        return { ok: false, error: '始终失败' };
      }),
    ];
    const scheduler = new TaskScheduler({ retryBaseDelayMs: 0 });
    const result = await scheduler.schedule(tasks);
    expect(calls).toBe(3); // 1 次初始 + 2 次重试
    expect(result.ok).toBe(false);
    expect(result.failed.get('always-fail')).toBe('始终失败');
  });

  it('指数退避：重试延迟按 2^attempt 增长（用退避基数验证调用时机）', async () => {
    const timestamps: number[] = [];
    let calls = 0;
    const tasks = [
      makeTask('slow-fail', async () => {
        calls += 1;
        timestamps.push(Date.now());
        return { ok: false, error: 'x' };
      }),
    ];
    // 基数 10ms：第 1 次重试等 10ms，第 2 次等 20ms（通过时间差验证趋势）
    const scheduler = new TaskScheduler({ retryBaseDelayMs: 10 });
    await scheduler.schedule(tasks);
    expect(calls).toBe(3);
    expect(timestamps).toHaveLength(3);
    const gap1 = (timestamps[1] ?? 0) - (timestamps[0] ?? 0);
    const gap2 = (timestamps[2] ?? 0) - (timestamps[1] ?? 0);
    expect(gap1).toBeGreaterThanOrEqual(10);
    expect(gap2).toBeGreaterThanOrEqual(20);
  });
});

// ── 调度：文件冲突策略 ───────────────────────────────────────

describe('文件冲突策略（error / serialize）', () => {
  it("策略 'error'：冲突时不执行任何任务，返回冲突列表", async () => {
    let executed = false;
    const tasks = [
      makeTask(
        'a',
        async () => {
          executed = true;
          return { ok: true };
        },
        { files: ['src/x.ts'] },
      ),
      makeTask(
        'b',
        async () => {
          executed = true;
          return { ok: true };
        },
        { files: ['src/x.ts'] },
      ),
    ];
    const scheduler = new TaskScheduler({ fileConflict: 'error' });
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(false);
    expect(executed).toBe(false); // 未执行任何任务
    expect(result.fileConflicts).toHaveLength(1);
    expect(result.fileConflicts[0]?.file).toBe('src/x.ts');
  });

  it("策略 'serialize'：冲突任务自动串行化（后执行者依赖先执行者）", async () => {
    const orderLog: string[] = [];
    const tasks = [
      makeTask(
        'a',
        async () => {
          orderLog.push('a');
          return { ok: true };
        },
        { files: ['src/x.ts'] },
      ),
      makeTask(
        'b',
        async () => {
          orderLog.push('b');
          return { ok: true };
        },
        { files: ['src/x.ts'] },
      ),
    ];
    const scheduler = new TaskScheduler({ fileConflict: 'serialize', concurrency: 2 });
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(true);
    expect(result.fileConflicts).toEqual([]);
    expect(result.completed.size).toBe(2);
    // 输入顺序 a 先执行，b 依赖 a（严格串行，无并发窗口）
    expect(orderLog).toEqual(['a', 'b']);
  });

  it('默认策略为 error（未指定 fileConflict）', async () => {
    const tasks = [
      makeTask('a', () => ({ ok: true }), { files: ['src/x.ts'] }),
      makeTask('b', () => ({ ok: true }), { files: ['src/x.ts'] }),
    ];
    const scheduler = new TaskScheduler();
    const result = await scheduler.schedule(tasks);
    expect(result.ok).toBe(false);
    expect(result.fileConflicts).toHaveLength(1);
  });
});
