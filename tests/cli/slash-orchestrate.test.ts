/**
 * /orchestrate 斜杠命令测试（v3.1 M5 / T5.2）。
 *
 * 覆盖验收标准：
 * - 解析：/orchestrate <任务> → { task }；/orchestrate（无任务）→ 提示用法；非 /orchestrate → null；
 * - 执行：FakeModel 驱动拆解 → 团队执行 → 结果转为聊天消息（✅/❌ 摘要）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  executeOrchestrateCommand,
  parseOrchestrateCommand,
} from '../../src/cli/slash/orchestrate';

describe('parseOrchestrateCommand', () => {
  it('/orchestrate 实现TODO → task', () => {
    expect(parseOrchestrateCommand('/orchestrate 实现TODO应用')).toEqual({
      task: '实现TODO应用',
    });
  });

  it('/orchestrate（无任务）→ task undefined', () => {
    expect(parseOrchestrateCommand('/orchestrate')).toEqual({ task: undefined });
  });

  it('/orchestrate  （空白）→ task undefined', () => {
    expect(parseOrchestrateCommand('/orchestrate   ')).toEqual({ task: undefined });
  });

  it('非 /orchestrate → null', () => {
    expect(parseOrchestrateCommand('hello')).toBeNull();
    expect(parseOrchestrateCommand('/review')).toBeNull();
    expect(parseOrchestrateCommand('/skill list')).toBeNull();
  });
});

describe('executeOrchestrateCommand', () => {
  it('无任务 → 用法提示（handled）', async () => {
    const result = await executeOrchestrateCommand(
      { task: undefined },
      {
        runTeam: vi.fn(),
      },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('用法');
  });

  it('执行成功 → ✅ 摘要消息', async () => {
    const result = await executeOrchestrateCommand(
      { task: '实现TODO' },
      {
        runTeam: async () => ({
          ok: true,
          summary: '✅ 全部 3 个任务完成',
          tasks: [],
          artifacts: [],
        }),
      },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('✅');
    expect(result.message?.content).toContain('全部 3 个任务完成');
  });

  it('执行失败（拆解失败 / 未收敛）→ ❌ 摘要消息', async () => {
    const result = await executeOrchestrateCommand(
      { task: '实现TODO' },
      {
        runTeam: async () => ({
          ok: false,
          summary: '需求拆解失败: 模型输出不是合法 JSON',
          tasks: [],
          artifacts: [],
        }),
      },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('❌');
    expect(result.message?.content).toContain('需求拆解失败');
  });

  it('用户取消 → ❌ 未确认摘要', async () => {
    const result = await executeOrchestrateCommand(
      { task: '实现TODO' },
      {
        runTeam: async () => ({
          ok: false,
          summary: '用户未确认拆解方案，已取消',
          tasks: [{ id: 't1', description: 'd', agent: 'coder', dependencies: [] }],
          artifacts: [],
        }),
      },
    );
    expect(result.message?.content).toContain('未确认');
  });

  it('拆解失败带 diagnostics（parse）→ 消息含诊断类型 + 原始输出（v3.2 T3.3）', async () => {
    const result = await executeOrchestrateCommand(
      { task: '实现TODO' },
      {
        runTeam: async () => ({
          ok: false,
          summary: '需求拆解失败: 模型输出不是合法 JSON',
          tasks: [],
          artifacts: [],
          diagnostics: {
            kind: 'parse',
            rawOutput: '不是 JSON 输出',
            message: '需求拆解失败: 模型输出不是合法 JSON',
          },
        }),
      },
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('格式解析失败');
    expect(result.message?.content).toContain('模型原始输出');
    expect(result.message?.content).toContain('不是 JSON 输出');
  });

  it('拆解失败带 diagnostics（network）→ 消息区分网络失败且无原始输出（v3.2 T3.3）', async () => {
    const result = await executeOrchestrateCommand(
      { task: '实现TODO' },
      {
        runTeam: async () => ({
          ok: false,
          summary: '需求拆解失败: 模型调用错误（fetch failed）',
          tasks: [],
          artifacts: [],
          diagnostics: {
            kind: 'network',
            message: '需求拆解失败: 模型调用错误（fetch failed）',
          },
        }),
      },
    );
    expect(result.message?.content).toContain('网络/API 调用失败');
    expect(result.message?.content).not.toContain('模型原始输出');
  });
});
