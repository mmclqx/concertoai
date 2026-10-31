/**
 * 会话内 token 用量累加与就地计价（v5.0 K15「成本熔断判据失效」的修法 ①）。
 *
 * ## 为什么需要它
 *
 * 此前**唯一**成本口径是「跑前余额 − 跑后余额」，而 DeepSeek 余额接口
 * ① 只有 2 位小数、② 结算有延迟 —— 于是「刚跑完差 0」被当成「没花钱」，
 * 「单场景超 ¥1 立刻停」这条闸门在真正超支时**不会响**（实测 `--fix` 一次花 ≈¥2.11，
 * 脚本打印「差 0」）。
 *
 * 正确做法是用响应里的 `usage`（模型自己报的 token 数）**本地累加 + 就地计价**，
 * 不依赖结算窗口，精度也不再被 1 分钱卡住。
 *
 * ## 为什么放在 `DeepSeekClient` 单点
 *
 * 花钱的调用链有 4 条（`loop` / `reviewer/autofix` / `core/commit-message` /
 * `loop/self-heal/model`），但**它们用的是同一个 client 实例**。
 * 单点捕获一次，就不需要每条链各自透传（各自透传要改 5 处，且以后新增链路必漏）。
 *
 * ## 诚实原则（这条比数字重要）
 *
 * - 拿不到 usage（注入的 mock client / 老客户端）→ `measured: false`，
 *   调用方必须说「未统计」，**不许打印一个假的 ¥0**；
 * - 模型 ID 不在价格表里 → `priced: false` + `unknownModels`，金额只含可计价部分并如实标注；
 * - 计价时刻按**本次请求发生时刻**取价（`at` 由调用方注入），跨高峰 / 空闲档不会串价。
 */

import { costFor, getModel } from './models';

/** 一次调用的 usage 样本（只取计价需要的字段，容忍缺失）。 */
export interface UsageSample {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** 缓存命中的输入 token 数（官方可能不返回）。 */
  prompt_cache_hit_tokens?: number;
}

/** 累加结果快照（纯数据，可安全序列化 / 跨进程打印）。 */
export interface UsageTotals {
  /** 记录到 usage 的调用次数（并发子代理各算一次）。 */
  calls: number;
  /** 累计输入 token（含缓存命中）。 */
  input: number;
  /** 累计输出 token。 */
  output: number;
  /** 累计缓存命中输入 token。 */
  cacheHit: number;
  /** 累计成本（元）；只包含价格表里查得到的模型。 */
  cost: number;
  /** 是否至少拿到过一次真实 usage（false = 成本不可度量，必须如实说「未统计」）。 */
  measured: boolean;
  /** 是否全部调用都能计价（false = 含未定价模型，`cost` 只是下限）。 */
  priced: boolean;
  /** 价格表里查不到的模型 ID（去重，供如实说明）。 */
  unknownModels: string[];
}

/** 空快照（`measured: false`：还没花过钱，也还没量过）。 */
export function emptyUsageTotals(): UsageTotals {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheHit: 0,
    cost: 0,
    measured: false,
    priced: true,
    unknownModels: [],
  };
}

/**
 * 归一化 token 计数：非数字 / NaN / 负数 / Infinity 一律按 0。
 *
 * 服务端偶尔返回 `null` 或负数没有意义，直接累加会让成本变成 NaN，
 * 而 `NaN > 阈值` 恒为 false —— 又一个「闸门安静失效」。所以入口先拍平。
 */
function tokenCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/** 可累计的用量累加器（`DeepSeekClient` 持有实例；测试可直接 new）。 */
export class UsageTally {
  private totals: UsageTotals = emptyUsageTotals();

  /**
   * 记录一次调用的 usage 并就地计价。
   *
   * @param sample 响应里的 usage（缺失字段按 0 处理）
   * @param modelId 本次请求使用的模型 ID（决定单价；**不是**默认模型）
   * @param at 本次请求发生时刻（决定高峰 / 空闲档价）
   * @returns 累加后的快照
   */
  add(sample: UsageSample, modelId: string, at: Date): UsageTotals {
    const input = tokenCount(sample.prompt_tokens);
    const output = tokenCount(sample.completion_tokens);
    // 缓存命中不可能超过输入总量（服务端异常时按输入量截断，避免负的未命中 token）
    const cacheHit = Math.min(tokenCount(sample.prompt_cache_hit_tokens), input);

    const totals = this.totals;
    totals.calls += 1;
    totals.input += input;
    totals.output += output;
    totals.cacheHit += cacheHit;
    totals.measured = true;

    if (getModel(modelId) === undefined) {
      // 未定价模型：token 照记，金额不计 —— 并且要让调用方知道「这数只是下限」
      totals.priced = false;
      if (!totals.unknownModels.includes(modelId)) {
        totals.unknownModels.push(modelId);
      }
    } else {
      totals.cost += costFor(modelId, input, output, cacheHit, at);
    }
    return this.snapshot();
  }

  /** 当前快照（深拷贝：调用方改不动内部状态）。 */
  snapshot(): UsageTotals {
    return { ...this.totals, unknownModels: [...this.totals.unknownModels] };
  }

  /** 清零（同一 client 内需要分别统计两段时用；产品侧目前不用）。 */
  reset(): void {
    this.totals = emptyUsageTotals();
  }
}

/** 会上报 usage 的客户端契约（`DeepSeekClient` 实现；注入的假 client 通常不实现）。 */
export interface UsageMetered {
  usageTotals(): UsageTotals;
}

/**
 * 守卫：对象是否具备 usage 计量能力。
 *
 * 用 `typeof === 'function'` 而不是 `instanceof`：动词拿到的常是 `ModelClient` 接口
 * （测试注入假实现），`instanceof` 会把「能力探测」变成「具体类探测」。
 */
export function isUsageMetered(value: unknown): value is UsageMetered {
  const candidate = value as { usageTotals?: unknown } | null | undefined;
  return typeof candidate?.usageTotals === 'function';
}

/**
 * 读一次快照；不具备计量能力时返回 `undefined`。
 *
 * 返回 `undefined` 而不是造一个全 0 快照 —— 全 0 会被渲染成「这次没花钱」，
 * 而事实是「这次量不到」，两者对用户的含义完全相反。
 */
export function readUsageTotals(value: unknown): UsageTotals | undefined {
  if (!isUsageMetered(value)) {
    return undefined;
  }
  try {
    return value.usageTotals();
  } catch {
    // 计量本身出问题不该把整条命令带崩：如实降级为「未统计」
    return undefined;
  }
}
