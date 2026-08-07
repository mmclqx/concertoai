import { describe, expect, it } from 'vitest';

import { costFor, getDefaultModel, getModel, listModels } from '../../src/model/models';

describe('模型表', () => {
  it('包含 flash 与 pro 两个模型', () => {
    const ids = listModels().map((m) => m.id);
    expect(ids).toContain('deepseek-v4-flash');
    expect(ids).toContain('deepseek-v4-pro');
  });

  it('模型 ID 唯一', () => {
    const ids = listModels().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('默认模型为 deepseek-v4-flash', () => {
    expect(getDefaultModel().id).toBe('deepseek-v4-flash');
  });

  it('getModel 按 ID 查找，未知返回 undefined', () => {
    expect(getModel('deepseek-v4-flash')?.label).toBe('DeepSeek V4 Flash');
    expect(getModel('no-such-model')).toBeUndefined();
  });

  it('每个模型定价与上下文窗口均为正数', () => {
    for (const model of listModels()) {
      expect(model.inputPricePerM).toBeGreaterThan(0);
      expect(model.outputPricePerM).toBeGreaterThan(0);
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });
});

describe('costFor', () => {
  it('成本 = 输入/输出 token 按各自单价计算', () => {
    const model = listModels()[0];
    if (model === undefined) {
      throw new Error('测试夹具：模型表为空');
    }
    const input = 500_000;
    const output = 100_000;
    expect(costFor(model.id, input, 0)).toBeCloseTo((input / 1e6) * model.inputPricePerM);
    expect(costFor(model.id, 0, output)).toBeCloseTo((output / 1e6) * model.outputPricePerM);
    expect(costFor(model.id, input, output)).toBeCloseTo(
      (input / 1e6) * model.inputPricePerM + (output / 1e6) * model.outputPricePerM,
    );
  });

  it('未知模型抛错', () => {
    expect(() => costFor('no-such-model', 1, 1)).toThrow('未知模型');
  });
});
