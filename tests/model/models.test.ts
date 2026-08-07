import { describe, expect, it } from 'vitest';

import type { ModelProfile } from '../../src/model/models';
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
      expect(model.inputCacheHitPricePerM).toBeGreaterThan(0);
      expect(model.rateLimit).toBeGreaterThan(0);
    }
  });

  it('模型 ID、上下文窗口与定价与 DeepSeek 官方定价页一致（2026-08-07 核实）', () => {
    const flash = getModel('deepseek-v4-flash');
    const pro = getModel('deepseek-v4-pro');
    expect(flash).toBeDefined();
    expect(pro).toBeDefined();
    const f = flash as ModelProfile;
    const p = pro as ModelProfile;

    // 上下文窗口 1M
    expect(f.contextWindow).toBe(1_000_000);
    expect(p.contextWindow).toBe(1_000_000);
    // flash：输入 1.00 / 缓存命中 0.02 / 输出 2.00（元每百万 token），并发 2500
    expect(f.inputPricePerM).toBe(1.0);
    expect(f.outputPricePerM).toBe(2.0);
    expect(f.inputCacheHitPricePerM).toBe(0.02);
    expect(f.rateLimit).toBe(2500);
    // pro：输入 3.00 / 缓存命中 0.025 / 输出 6.00（元每百万 token），并发 500
    expect(p.inputPricePerM).toBe(3.0);
    expect(p.outputPricePerM).toBe(6.0);
    expect(p.inputCacheHitPricePerM).toBe(0.025);
    expect(p.rateLimit).toBe(500);
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
