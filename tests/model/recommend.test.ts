/**
 * 智能模型推荐测试（v4.0 M3 T3.2）。
 *
 * 覆盖：复杂度检测阈值 / 预算×复杂度×本地 → 推荐组合 / 月成本预估基准。
 */

import { describe, expect, it } from 'vitest';

import { detectComplexity, recommendProvider } from '../../src/model/recommend';

describe('detectComplexity', () => {
  it('小项目（文件少 + 依赖少）→ small', () => {
    expect(detectComplexity({ fileCount: 20, dependencyCount: 5 })).toBe('small');
  });

  it('中项目（文件 60+ 或依赖 15+）→ medium', () => {
    expect(detectComplexity({ fileCount: 100, dependencyCount: 5 })).toBe('medium');
    expect(detectComplexity({ fileCount: 20, dependencyCount: 20 })).toBe('medium');
  });

  it('大项目（文件 300+ 或依赖 80+）→ large', () => {
    expect(detectComplexity({ fileCount: 400, dependencyCount: 5 })).toBe('large');
    expect(detectComplexity({ fileCount: 20, dependencyCount: 100 })).toBe('large');
  });

  it('缺省参数 → small', () => {
    expect(detectComplexity({})).toBe('small');
  });
});

describe('recommendProvider', () => {
  it('默认（medium 预算 + medium 复杂度 + 无本地）→ deepseek/deepseek-v4-flash', () => {
    const r = recommendProvider({});
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-v4-flash');
    expect(r.monthlyCost).toBeGreaterThan(0);
  });

  it('low 预算 + 本地可用 → ollama（成本 0）', () => {
    const r = recommendProvider({ budget: 'low', localAvailable: true });
    expect(r.provider).toBe('ollama');
    expect(r.monthlyCost).toBe(0);
  });

  it('low 预算 + 无本地 → deepseek（低价位）', () => {
    const r = recommendProvider({ budget: 'low', localAvailable: false });
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-v4-flash');
  });

  it('high 预算 + large 复杂度 → openai/gpt-4o', () => {
    const r = recommendProvider({ budget: 'high', complexity: 'large' });
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('gpt-4o');
    // gpt-4o 月成本 > deepseek-chat 默认组合
    expect(r.monthlyCost).toBeGreaterThan(recommendProvider({}).monthlyCost);
  });

  it('high 预算 + small 复杂度 → openai/gpt-4o-mini（性价比档）', () => {
    const r = recommendProvider({ budget: 'high', complexity: 'small' });
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('gpt-4o-mini');
    expect(r.monthlyCost).toBeLessThan(
      recommendProvider({ budget: 'high', complexity: 'large' }).monthlyCost,
    );
  });

  it('medium 预算 + 本地可用 → 仍默认 deepseek（均衡，不因本地存在而改变）', () => {
    const r = recommendProvider({ budget: 'medium', localAvailable: true });
    expect(r.provider).toBe('deepseek');
  });

  it('dailySessions 影响月成本（10 vs 40 对话）', () => {
    const base = recommendProvider({ dailySessions: 10 });
    const more = recommendProvider({ dailySessions: 40 });
    expect(more.monthlyCost).toBeCloseTo(base.monthlyCost * 4, 8);
  });

  it('reason 返回理由键（供 doctor 映射 i18n 文案）', () => {
    expect(recommendProvider({ budget: 'low', localAvailable: true }).reason).toBe('lowLocal');
    expect(recommendProvider({}).reason).toBe('medium');
  });
});
