/**
 * `/model` 斜杠命令测试（v5.0 T6）。
 *
 * 安全红线（比功能更重要的三条）：
 * 1. **升级方向必须确认**，且确认回调异常/返回 false 一律保持原模型（fail-closed）；
 * 2. **降级方向直接生效**（省钱方向不需要给用户增加摩擦）；
 * 3. **非 deepseek Provider 拒绝切换**（不在价格表内的模型切换无意义，不能假装成功）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  executeModelCommand,
  type ModelCommandContext,
  parseModelCommand,
} from '../../src/cli/slash/model';

/** 周三 20:00 → 空闲（固定时刻，避免时间依赖）。 */
const OFFPEAK_AT = new Date(2026, 9, 28, 20, 0, 0);

/** 构造执行上下文（默认 deepseek + 空闲时刻）。 */
function makeCtx(overrides: Partial<ModelCommandContext> = {}): ModelCommandContext {
  return {
    currentModel: 'deepseek-v4-flash',
    providerName: 'deepseek',
    confirm: async () => true,
    at: OFFPEAK_AT,
    ...overrides,
  };
}

describe('parseModelCommand', () => {
  it('非 /model 输入返回 null（不误拦普通对话）', () => {
    expect(parseModelCommand('你好')).toBeNull();
    expect(parseModelCommand('/modellist')).toBeNull();
    expect(parseModelCommand('/review')).toBeNull();
  });

  it('/model → status；/model list → list；/model auto → auto', () => {
    expect(parseModelCommand('/model')).toEqual({ type: 'status' });
    expect(parseModelCommand('  /model  ')).toEqual({ type: 'status' });
    expect(parseModelCommand('/model list')).toEqual({ type: 'list' });
    expect(parseModelCommand('/model auto')).toEqual({ type: 'auto' });
    expect(parseModelCommand('/model AUTO')).toEqual({ type: 'auto' });
  });

  it('/model <id> → switch（含 trim）', () => {
    expect(parseModelCommand('/model deepseek-v4-pro')).toEqual({
      type: 'switch',
      modelId: 'deepseek-v4-pro',
    });
    expect(parseModelCommand('/model   deepseek-v4-pro  ')).toEqual({
      type: 'switch',
      modelId: 'deepseek-v4-pro',
    });
  });

  it('未知模型 → unknown（带可用清单，不静默吞掉）', () => {
    const cmd = parseModelCommand('/model gpt-5');
    expect(cmd?.type).toBe('unknown');
    if (cmd?.type === 'unknown') {
      expect(cmd.message).toContain('未知模型');
      expect(cmd.message).toContain('deepseek-v4-flash');
      expect(cmd.message).toContain('auto');
    }
  });
});

describe('executeModelCommand：查看类命令', () => {
  it('/model 显示当前模型 + 当前时段单价', async () => {
    const result = await executeModelCommand({ type: 'status' }, makeCtx());
    expect(result.handled).toBe(true);
    const content = result.message?.content ?? '';
    expect(content).toContain('DeepSeek V4 Flash');
    expect(content).toContain('空闲价');
    expect(content).toContain('¥1.5/百万');
    expect(result.nextModel).toBeUndefined(); // 查看不改变模型
  });

  it('/model list 列出全部模型并标记当前', async () => {
    const result = await executeModelCommand({ type: 'list' }, makeCtx());
    const content = result.message?.content ?? '';
    expect(content).toContain('deepseek-v4-flash');
    expect(content).toContain('deepseek-v4-pro');
    expect(content).toContain('← 当前');
    expect(result.nextModel).toBeUndefined();
  });

  it('/model auto 启用预设：返回起始模型 + 策略说明含「不会自动升级」', async () => {
    const result = await executeModelCommand(
      { type: 'auto' },
      makeCtx({ currentModel: 'deepseek-v4-pro' }),
    );
    expect(result.handled).toBe(true);
    expect(result.nextModel).toBe('deepseek-v4-flash');
    expect(result.message?.content).toContain('不会自动升级');
    expect(result.message?.content).toContain('auto 预设');
  });

  it('/model auto 不需要确认（设初值不是花钱动作）', async () => {
    const confirm = vi.fn(async () => true);
    await executeModelCommand({ type: 'auto' }, makeCtx({ confirm }));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('executeModelCommand：切换（成本方向决定是否确认）', () => {
  it('升级 flash→pro → 先确认，确认后切换', async () => {
    // 显式声明参数类型：否则 mock.calls 被推断成 []（无参数元组），取不到提问文案
    const confirm = vi.fn(async (_question: string) => true);
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-pro' },
      makeCtx({ confirm }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    // 确认文案必须含成本对比（不能只问「是否切换」）
    const question = String(confirm.mock.calls[0]?.[0] ?? '');
    expect(question).toContain('成本对比');
    expect(question).toContain('3.0 倍');
    expect(result.nextModel).toBe('deepseek-v4-pro');
    expect(result.message?.content).toContain('已切换到');
  });

  it('升级时用户拒绝（返回 false）→ 保持原模型', async () => {
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-pro' },
      makeCtx({ confirm: async () => false }),
    );
    expect(result.nextModel).toBeUndefined();
    expect(result.message?.content).toContain('已取消切换');
    expect(result.message?.content).toContain('成本对比');
  });

  it('【fail-closed】确认回调抛错（审批中断/Esc）→ 不切换', async () => {
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-pro' },
      makeCtx({
        confirm: async () => {
          throw new Error('审批被中断');
        },
      }),
    );
    expect(result.nextModel).toBeUndefined();
    expect(result.message?.content).toContain('已取消切换');
  });

  it('降级 pro→flash → 不需要确认，直接生效', async () => {
    const confirm = vi.fn(async () => true);
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-flash' },
      makeCtx({ currentModel: 'deepseek-v4-pro', confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(result.nextModel).toBe('deepseek-v4-flash');
    expect(result.message?.content).toContain('省钱方向');
  });

  it('已是当前模型 → 不重复切换、只提示', async () => {
    const confirm = vi.fn(async () => true);
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-flash' },
      makeCtx({ confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(result.nextModel).toBeUndefined();
    expect(result.message?.content).toContain('无需切换');
  });

  it('非 deepseek Provider → 明确拒绝并给出正确命令', async () => {
    const result = await executeModelCommand(
      { type: 'switch', modelId: 'deepseek-v4-pro' },
      makeCtx({ providerName: 'ollama' }),
    );
    expect(result.nextModel).toBeUndefined();
    expect(result.message?.content).toContain('ollama');
    expect(result.message?.content).toContain('provider switch');
  });

  it('未知命令 → 回显错误但不崩', async () => {
    const result = await executeModelCommand(
      { type: 'unknown', message: '未知模型：x' },
      makeCtx(),
    );
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('未知模型');
  });
});

describe('/model 状态里的升级提示：只说不动手', () => {
  it('flash 上状态文本含升级提示与成本倍数（命令可复制）', async () => {
    const result = await executeModelCommand({ type: 'status' }, makeCtx());
    const content = result.message?.content ?? '';
    expect(content).toContain('💡');
    expect(content).toContain('/model deepseek-v4-pro');
    expect(content).toContain('需确认');
    // 提示不等于切换：状态命令绝不改变模型
    expect(result.nextModel).toBeUndefined();
  });

  it('pro（已最高档）状态文本无升级提示，仍保留用法行', async () => {
    const result = await executeModelCommand(
      { type: 'status' },
      makeCtx({ currentModel: 'deepseek-v4-pro' }),
    );
    const content = result.message?.content ?? '';
    expect(content).not.toContain('💡');
    expect(content).toContain('用法：/model auto');
  });
});
