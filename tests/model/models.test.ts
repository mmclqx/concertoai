import { afterEach, describe, expect, it } from 'vitest';

import { configureHolidayCalendar, resetHolidayCalendar } from '../../src/core/holidays';
import type { ModelProfile } from '../../src/model/models';
import {
  cacheHitCostFor,
  costFor,
  getDefaultModel,
  getModel,
  listModels,
  priceFor,
  priceTierFor,
  tierLabel,
} from '../../src/model/models';

// ── 固定时刻夹具（时间注入，绝不依赖真实当前时间；AGENTS R5）──
/** 周三 10:00 → 计价高峰。 */
const PEAK_AT = new Date(2026, 9, 28, 10, 0, 0);
/** 周三 20:00 → 空闲。 */
const OFFPEAK_AT = new Date(2026, 9, 28, 20, 0, 0);
/** 周六 10:00 → 空闲（周末不涨价）。 */
const WEEKEND_AT = new Date(2026, 9, 31, 10, 0, 0);
/** 周四 10:00 → 高峰（作为「非节假日的同一高峰时刻」对照）。 */
const NON_HOLIDAY_PEAK_AT = new Date(2026, 9, 29, 10, 0, 0);

afterEach(() => {
  resetHolidayCalendar();
});

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

  it('每个模型双档定价与上下文窗口均为正数，且高峰价严格高于空闲价', () => {
    for (const model of listModels()) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.rateLimit).toBeGreaterThan(0);
      for (const set of [model.offPeak, model.peak]) {
        expect(set.input).toBeGreaterThan(0);
        expect(set.output).toBeGreaterThan(0);
        expect(set.cacheHit).toBeGreaterThan(0);
        // 缓存命中价必须显著低于未命中价（否则缓存优惠失去意义）
        expect(set.cacheHit).toBeLessThan(set.input);
      }
      expect(model.peak.input).toBeGreaterThan(model.offPeak.input);
      expect(model.peak.output).toBeGreaterThan(model.offPeak.output);
      expect(model.peak.cacheHit).toBeGreaterThan(model.offPeak.cacheHit);
    }
  });

  it('价格表 = 官方定价页核对值（高峰 / 空闲双档 + 并发 2500/500）', () => {
    const flash = getModel('deepseek-v4-flash') as ModelProfile;
    const pro = getModel('deepseek-v4-pro') as ModelProfile;

    // 上下文窗口 1M
    expect(flash.contextWindow).toBe(1_000_000);
    expect(pro.contextWindow).toBe(1_000_000);

    // flash：缓存命中 0.02/0.04 · 未命中 1/2 · 输出 4.5/9.0（空闲/高峰），并发 2500
    // （v5.0 T7 修订：用户核对官方定价页后订正缓存命中与输入价，原任务书数字有误）
    expect(flash.offPeak).toEqual({ input: 1, output: 4.5, cacheHit: 0.02 });
    expect(flash.peak).toEqual({ input: 2, output: 9, cacheHit: 0.04 });
    expect(flash.rateLimit).toBe(2500);

    // pro：缓存命中 0.15/0.30 · 未命中 4.5/9.0 · 输出 13.5/27.0（空闲/高峰），并发 500
    expect(pro.offPeak).toEqual({ input: 4.5, output: 13.5, cacheHit: 0.15 });
    expect(pro.peak).toEqual({ input: 9.0, output: 27.0, cacheHit: 0.3 });
    expect(pro.rateLimit).toBe(500);
  });
});

describe('priceTierFor：计价档位（纯函数 + 时间注入）', () => {
  it('工作日高峰时段 → peak', () => {
    expect(priceTierFor(new Date(2026, 9, 28, 9, 0, 0))).toBe('peak'); // 9:00 起点（左闭）
    expect(priceTierFor(new Date(2026, 9, 28, 10, 0, 0))).toBe('peak');
    expect(priceTierFor(new Date(2026, 9, 28, 11, 59, 0))).toBe('peak');
    expect(priceTierFor(new Date(2026, 9, 28, 14, 0, 0))).toBe('peak');
    expect(priceTierFor(new Date(2026, 9, 28, 17, 59, 0))).toBe('peak');
  });

  it('边界：12:00 / 18:00 整不属于高峰（左闭右开）', () => {
    expect(priceTierFor(new Date(2026, 9, 28, 12, 0, 0))).toBe('offpeak');
    expect(priceTierFor(new Date(2026, 9, 28, 18, 0, 0))).toBe('offpeak');
  });

  it('边界：0 点整 / 午休 13 点 → 空闲', () => {
    expect(priceTierFor(new Date(2026, 9, 28, 0, 0, 0))).toBe('offpeak');
    expect(priceTierFor(new Date(2026, 9, 28, 13, 0, 0))).toBe('offpeak');
    expect(priceTierFor(new Date(2026, 9, 28, 23, 59, 59))).toBe('offpeak');
  });

  it('周末同点一律空闲（周六 / 周日）', () => {
    expect(priceTierFor(WEEKEND_AT)).toBe('offpeak'); // 2026-10-31 周六
    expect(priceTierFor(new Date(2026, 10, 1, 10, 0, 0))).toBe('offpeak'); // 2026-11-01 周日
    // 对照：同点工作日照常高峰（确认不是"整周空闲"的假绿）
    expect(priceTierFor(new Date(2026, 9, 30, 10, 0, 0))).toBe('peak'); // 2026-10-30 周五
  });

  it('tierLabel 双语标注', () => {
    expect(tierLabel('peak')).toBe('高峰价');
    expect(tierLabel('offpeak')).toBe('空闲价');
  });

  // ── v5.0 T7 修订：计价档位必须排除法定节假日（用户核对官方规则后追加）──
  it('法定节假日（周三）→ 空闲档，成本与空闲价一致且低于同日高峰价', () => {
    configureHolidayCalendar({ holidays: ['2026-10-28'] });
    expect(priceTierFor(PEAK_AT)).toBe('offpeak');
    const holidayCost = costFor('deepseek-v4-flash', 1_000_000, 0, 0, PEAK_AT);
    // 与「同日空闲时段」等价（1 元/M 输入）；低于「非节假日的同日高峰」（2 元/M）
    expect(holidayCost).toBeCloseTo(costFor('deepseek-v4-flash', 1_000_000, 0, 0, OFFPEAK_AT));
    expect(holidayCost).toBeLessThan(
      costFor('deepseek-v4-flash', 1_000_000, 0, 0, NON_HOLIDAY_PEAK_AT),
    );
  });

  it('调休上班日（周六）→ 高峰档（补班日按工作日计价）', () => {
    configureHolidayCalendar({ makeupWorkdays: ['2026-10-31'] });
    expect(priceTierFor(WEEKEND_AT)).toBe('peak');
  });

  it('未配置节假日表时行为与修订前一致（不静默改变既有计价）', () => {
    resetHolidayCalendar();
    expect(priceTierFor(PEAK_AT)).toBe('peak');
    expect(priceTierFor(WEEKEND_AT)).toBe('offpeak');
  });
});

describe('priceFor', () => {
  it('按时段返回对应价格集', () => {
    expect(priceFor('deepseek-v4-flash', 'peak').input).toBe(2);
    expect(priceFor('deepseek-v4-flash', 'offpeak').input).toBe(1);
  });

  it('未知模型抛错', () => {
    expect(() => priceFor('no-such-model', 'peak')).toThrow('未知模型');
  });
});

describe('costFor', () => {
  it('成本 = 输入/输出 token 按各自单价计算（空闲时段）', () => {
    const model = listModels()[0];
    if (model === undefined) {
      throw new Error('测试夹具：模型表为空');
    }
    const price = priceFor(model.id, 'offpeak');
    const input = 500_000;
    const output = 100_000;
    expect(costFor(model.id, input, 0, 0, OFFPEAK_AT)).toBeCloseTo((input / 1e6) * price.input);
    expect(costFor(model.id, 0, output, 0, OFFPEAK_AT)).toBeCloseTo((output / 1e6) * price.output);
    expect(costFor(model.id, input, output, 0, OFFPEAK_AT)).toBeCloseTo(
      (input / 1e6) * price.input + (output / 1e6) * price.output,
    );
  });

  it('同一用量在高峰时段恰为空闲时段的 2 倍', () => {
    const off = costFor('deepseek-v4-flash', 1_000_000, 1_000_000, 0, OFFPEAK_AT);
    const peak = costFor('deepseek-v4-flash', 1_000_000, 1_000_000, 0, PEAK_AT);
    expect(peak).toBeCloseTo(off * 2);
  });

  it('周末按空闲价计费', () => {
    expect(costFor('deepseek-v4-flash', 1_000_000, 0, 0, WEEKEND_AT)).toBeCloseTo(
      costFor('deepseek-v4-flash', 1_000_000, 0, 0, OFFPEAK_AT),
    );
  });

  it('未知模型抛错', () => {
    expect(() => costFor('no-such-model', 1, 1)).toThrow('未知模型');
  });

  it('缓存命中 token 按缓存命中价格计费（输入拆分）', () => {
    const flash = getModel('deepseek-v4-flash');
    if (flash === undefined) throw new Error('测试夹具：模型未找到');
    const price = priceFor(flash.id, 'offpeak');
    const input = 1_000_000;
    const cacheHit = 800_000;
    const miss = input - cacheHit; // 200_000
    const expected = (miss / 1e6) * price.input + (cacheHit / 1e6) * price.cacheHit;
    expect(costFor(flash.id, input, 0, cacheHit, OFFPEAK_AT)).toBeCloseTo(expected);
    // 缓存命中成本应远低于普通输入
    expect((cacheHit / 1e6) * price.cacheHit).toBeLessThan(0.1);
  });

  it('cacheHitCostFor 单独计算缓存命中成本（并按档位计价）', () => {
    const flash = getModel('deepseek-v4-flash');
    if (flash === undefined) throw new Error('测试夹具：模型未找到');
    const cacheHit = 500_000;
    expect(cacheHitCostFor(flash.id, cacheHit, OFFPEAK_AT)).toBeCloseTo(
      (cacheHit / 1e6) * priceFor(flash.id, 'offpeak').cacheHit,
    );
    expect(cacheHitCostFor(flash.id, cacheHit, PEAK_AT)).toBeCloseTo(
      (cacheHit / 1e6) * priceFor(flash.id, 'peak').cacheHit,
    );
    expect(cacheHitCostFor(flash.id, 0, OFFPEAK_AT)).toBe(0);
  });

  it('cacheHitCostFor 未知模型抛错', () => {
    expect(() => cacheHitCostFor('no-such-model', 1)).toThrow('未知模型');
  });
});
