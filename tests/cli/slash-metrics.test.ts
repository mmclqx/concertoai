/**
 * `/metrics` 斜杠命令测试（v5.0 T21）。
 *
 * 覆盖：解析（on/off/status/clear/裸命令/未知子命令）、执行回执、
 * **回执里承诺的永久命令必须真存在**（`concertoai config set metrics on|off`，
 * T10/T12 空头支票教训），以及 clear 的三条边缘路径（有数据 / 空文件 / 清空失败）。
 */

import { describe, expect, it } from 'vitest';

import { executeMetricsCommand, parseMetricsCommand } from '../../src/cli/slash/metrics';

describe('parseMetricsCommand：解析', () => {
  it('非 /metrics 命令 → null（不抢别的 handler）', () => {
    expect(parseMetricsCommand('/hints off')).toBeNull();
    expect(parseMetricsCommand('/metric')).toBeNull();
    expect(parseMetricsCommand('metrics on')).toBeNull();
    expect(parseMetricsCommand('')).toBeNull();
  });

  it('裸命令与 status 等价', () => {
    expect(parseMetricsCommand('/metrics')).toEqual({ type: 'status' });
    expect(parseMetricsCommand('/metrics status')).toEqual({ type: 'status' });
    expect(parseMetricsCommand('  /metrics  ')).toEqual({ type: 'status' });
  });

  it('四个子命令解析准确', () => {
    expect(parseMetricsCommand('/metrics on')).toEqual({ type: 'on' });
    expect(parseMetricsCommand('/metrics off')).toEqual({ type: 'off' });
    expect(parseMetricsCommand('/metrics clear')).toEqual({ type: 'clear' });
  });

  it('未知子命令 → unknown 且回执带原始输入（便于发现拼错）', () => {
    const cmd = parseMetricsCommand('/metrics maybe');
    expect(cmd?.type).toBe('unknown');
    if (cmd?.type === 'unknown') {
      expect(cmd.message).toContain('maybe');
    }
  });
});

describe('executeMetricsCommand：开关与状态', () => {
  it('/metrics on → 打开开关，回执给出永久开启命令与汇总入口', async () => {
    const result = await executeMetricsCommand({ type: 'on' }, { enabled: false });
    expect(result.handled).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.message.content).toContain('concertoai config set metrics on');
    expect(result.message.content).toContain('doctor --metrics');
  });

  it('/metrics off → 关闭开关，回执给出永久关闭命令（不改文件）', async () => {
    const result = await executeMetricsCommand({ type: 'off' }, { enabled: true });
    expect(result.enabled).toBe(false);
    expect(result.message.content).toContain('concertoai config set metrics off');
  });

  it('/metrics status 按当前开关给不同回执，且都带真实文件路径', async () => {
    const on = await executeMetricsCommand(
      { type: 'status' },
      { enabled: true, file: '/tmp/m.jsonl' },
    );
    expect(on.message.content).toContain('/tmp/m.jsonl');
    expect(on.enabled).toBeUndefined();
    const off = await executeMetricsCommand(
      { type: 'status' },
      { enabled: false, file: '/tmp/m.jsonl' },
    );
    expect(off.message.content).toContain('/tmp/m.jsonl');
  });

  it('unknown → 原样回执解析阶段的提示（不吞掉用户输入）', async () => {
    const result = await executeMetricsCommand(
      { type: 'unknown', message: '未知 metrics 子命令：maybe' },
      { enabled: true },
    );
    expect(result.message.content).toContain('maybe');
  });
});

describe('executeMetricsCommand：clear 的三条边缘路径', () => {
  it('有数据 → 回执报出清掉几条', async () => {
    const result = await executeMetricsCommand(
      { type: 'clear' },
      {
        enabled: true,
        readImpl: async () => ({ entries: [1, 2, 3] }),
        clearImpl: async () => ({ ok: true, removed: true }),
      },
    );
    expect(result.message.content).toContain('3');
  });

  it('空文件 → 明说「本来就是空的」，不说「清掉 0 条」以外的花话', async () => {
    const result = await executeMetricsCommand(
      { type: 'clear' },
      {
        enabled: true,
        readImpl: async () => ({ entries: [] }),
        clearImpl: async () => ({ ok: true, removed: false }),
      },
    );
    expect(result.message.content).toContain('空');
  });

  it('清空失败 → 如实回报错因（不假装成功）', async () => {
    const result = await executeMetricsCommand(
      { type: 'clear' },
      {
        enabled: true,
        readImpl: async () => ({ entries: [] }),
        clearImpl: async () => ({ ok: false, removed: false, error: 'EPERM' }),
      },
    );
    expect(result.message.content).toContain('EPERM');
  });

  it('读取抛错也不能挡住清空（用户明确要求的动作要执行到底）', async () => {
    let cleared = false;
    const result = await executeMetricsCommand(
      { type: 'clear' },
      {
        enabled: true,
        readImpl: async () => {
          throw new Error('boom');
        },
        clearImpl: async () => {
          cleared = true;
          return { ok: true, removed: true };
        },
      },
    );
    expect(cleared).toBe(true);
    expect(result.handled).toBe(true);
  });
});
