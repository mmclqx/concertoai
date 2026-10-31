/**
 * 用量累加与就地计价（K15）单测。
 *
 * ## 这组用例要钉死的是「不许安静地给出有利结论」
 *
 * K15 的原始故障不是算错数，而是**算不出来还说没事**：余额 2 位小数 + 结算延迟 →
 * 「差 0」被当成「没花钱」，闸门全程静默。所以这里除了「数对不对」，还必须钉住：
 * - 拿不到 usage → `measured: false`（调用方据此说「未统计」，不伪造 ¥0）；
 * - 未定价模型 → `priced: false` + 模型名单（金额只是下限，不许当全款）；
 * - 脏 token（NaN / 负数 / 缓存命中 > 输入）→ 不产生 NaN（`NaN > 阈值` 恒 false，
 *   又是一种「闸门失效」）。
 *
 * 时刻一律注入固定值，并与 `costFor` 的期望对齐后再比 —— 不假设「现在是不是高峰」
 * （`isPricingPeakTime` 依赖节假日配置，直接写死数字会变成时间 / 环境依赖型假绿）。
 */

import { describe, expect, it } from 'vitest';

import { costFor } from '../../src/model/models';
import {
  emptyUsageTotals,
  isUsageMetered,
  readUsageTotals,
  UsageTally,
} from '../../src/model/usage-tally';

/** 固定时刻（是否高峰不影响判据：期望值一律用同一个时刻的 `costFor` 推）。 */
const AT = new Date('2026-10-31T10:00:00+08:00');
const MODEL = 'deepseek-v4-flash';

describe('UsageTally', () => {
  it('空快照：没量过（measured=false）而不是「花了 0 元」', () => {
    const totals = new UsageTally().snapshot();
    expect(totals).toEqual(emptyUsageTotals());
    expect(totals.measured).toBe(false);
    expect(totals.cost).toBe(0);
  });

  it('单次调用：token 累加，金额与 costFor 同源（不另造价格表）', () => {
    const tally = new UsageTally();
    const totals = tally.add(
      { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400 },
      MODEL,
      AT,
    );
    expect(totals.measured).toBe(true);
    expect(totals.calls).toBe(1);
    expect(totals.input).toBe(1000);
    expect(totals.output).toBe(200);
    expect(totals.cacheHit).toBe(400);
    expect(totals.priced).toBe(true);
    expect(totals.cost).toBeCloseTo(costFor(MODEL, 1000, 200, 400, AT), 12);
  });

  it('多次调用累加（review 的 5 个并行子代理就是 5 次）', () => {
    const tally = new UsageTally();
    for (let i = 0; i < 5; i += 1) {
      tally.add({ prompt_tokens: 100, completion_tokens: 20 }, MODEL, AT);
    }
    const totals = tally.snapshot();
    expect(totals.calls).toBe(5);
    expect(totals.input).toBe(500);
    expect(totals.output).toBe(100);
    expect(totals.cost).toBeCloseTo(costFor(MODEL, 500, 100, 0, AT), 12);
  });

  it('缓存命中比未命中便宜（按 cacheHit 价计价，价格表不重复维护）', () => {
    const allHit = new UsageTally().add(
      { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_cache_hit_tokens: 1_000_000 },
      MODEL,
      AT,
    );
    const noHit = new UsageTally().add(
      { prompt_tokens: 1_000_000, completion_tokens: 0 },
      MODEL,
      AT,
    );
    expect(allHit.cost).toBeLessThan(noHit.cost);
  });

  it('未定价模型：token 照记、金额不计，并如实标注（priced=false + 名单）', () => {
    const tally = new UsageTally();
    const totals = tally.add(
      { prompt_tokens: 500, completion_tokens: 100 },
      'deepseek-not-in-table',
      AT,
    );
    expect(totals.measured).toBe(true);
    expect(totals.input).toBe(500);
    expect(totals.priced).toBe(false);
    expect(totals.unknownModels).toEqual(['deepseek-not-in-table']);
    expect(totals.cost).toBe(0);
  });

  it('未定价模型名单去重（同一未知模型调 3 次只记一次）', () => {
    const tally = new UsageTally();
    for (let i = 0; i < 3; i += 1) {
      tally.add({ prompt_tokens: 10, completion_tokens: 1 }, 'unknown-model', AT);
    }
    const totals = tally.snapshot();
    expect(totals.unknownModels).toEqual(['unknown-model']);
    expect(totals.calls).toBe(3);
  });

  it('脏 token 拍平为 0：不让 NaN / 负数污染成本（NaN 比较恒 false = 闸门又一次静默）', () => {
    const tally = new UsageTally();
    const totals = tally.add(
      {
        prompt_tokens: Number.NaN,
        completion_tokens: -5,
        prompt_cache_hit_tokens: Number.POSITIVE_INFINITY,
      },
      MODEL,
      AT,
    );
    expect(totals.input).toBe(0);
    expect(totals.output).toBe(0);
    expect(totals.cacheHit).toBe(0);
    expect(Number.isFinite(totals.cost)).toBe(true);
    expect(totals.cost).toBe(0);
  });

  it('缓存命中数超过输入总量时按输入量截断（不出现负的未命中 token）', () => {
    const tally = new UsageTally();
    const totals = tally.add(
      { prompt_tokens: 100, completion_tokens: 0, prompt_cache_hit_tokens: 999 },
      MODEL,
      AT,
    );
    expect(totals.cacheHit).toBe(100);
    expect(totals.cost).toBeCloseTo(costFor(MODEL, 100, 0, 100, AT), 12);
  });

  it('snapshot 是深拷贝：改返回值不影响内部状态', () => {
    const tally = new UsageTally();
    tally.add({ prompt_tokens: 1, completion_tokens: 1 }, 'unknown-model', AT);
    const first = tally.snapshot();
    first.input = 999;
    first.unknownModels.push('injected');
    const second = tally.snapshot();
    expect(second.input).toBe(1);
    expect(second.unknownModels).toEqual(['unknown-model']);
  });

  it('reset 清零（回到「没量过」而不是「花了 0 元」）', () => {
    const tally = new UsageTally();
    tally.add({ prompt_tokens: 10, completion_tokens: 10 }, MODEL, AT);
    tally.reset();
    expect(tally.snapshot()).toEqual(emptyUsageTotals());
  });
});

describe('readUsageTotals（能力守卫）', () => {
  it('具备 usageTotals 的对象 → 返回快照', () => {
    const tally = new UsageTally();
    tally.add({ prompt_tokens: 10, completion_tokens: 2 }, MODEL, AT);
    const client = { usageTotals: () => tally.snapshot() };
    expect(isUsageMetered(client)).toBe(true);
    expect(readUsageTotals(client)?.calls).toBe(1);
  });

  it('不具备计量能力（注入的假 client）→ undefined，而不是伪造全 0 快照', () => {
    const fakeClient = { streamChat: () => {} };
    expect(isUsageMetered(fakeClient)).toBe(false);
    expect(readUsageTotals(fakeClient)).toBeUndefined();
    expect(readUsageTotals(undefined)).toBeUndefined();
    expect(readUsageTotals(null)).toBeUndefined();
  });

  it('计量方法自己抛错 → undefined（降级为「未统计」，不把命令带崩）', () => {
    const broken = {
      usageTotals: () => {
        throw new Error('boom');
      },
    };
    expect(readUsageTotals(broken)).toBeUndefined();
  });
});
