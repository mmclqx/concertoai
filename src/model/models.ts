/**
 * 模型表与成本计算。
 *
 * **价格数据来源（v5.0 T7，已由用户核对官方定价页）**：
 * - 来源：DeepSeek 官方定价页 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
 *   （用户 2026-10-27 核对后给出订正值，见 ADR-038）；
 * - flash 原任务书数字有误（缓存命中 0.05/0.10、输入 1.5/3.0），**已按官方订正**为 0.02/0.04、1/2；
 * - pro 数字经核对无误；flash 输出价（4.5/9.0）用户未提出订正，保持原值。
 *
 * 双档计价：DeepSeek 按高峰 / 空闲两档计费，`priceTierFor(at)` 决定当前档位
 * （计价时段已排除中国法定节假日，见 `core/holidays.ts`），
 * 时间一律**注入**（不直接读 `Date.now()`），测试用固定时刻断言。
 */

import { isPricingPeakTime } from '../core/peak-time';

/** 价格档位。 */
export type PriceTier = 'peak' | 'offpeak';

/** 单档价格（元 / 百万 token）。 */
export interface PriceSet {
  /** 输入价格（缓存未命中）。 */
  input: number;
  /** 输出价格。 */
  output: number;
  /** 输入价格（缓存命中）。 */
  cacheHit: number;
}

export interface ModelProfile {
  /** API 请求使用的模型 ID。 */
  id: string;
  /** 中文展示名。 */
  label: string;
  /** 用途说明。 */
  description: string;
  /** 上下文窗口大小（token）。 */
  contextWindow: number;
  /** 空闲时段价格（元 / 百万 token）。 */
  offPeak: PriceSet;
  /** 高峰时段价格（元 / 百万 token）。 */
  peak: PriceSet;
  /** API 并发限制。 */
  rateLimit: number;
  /** 是否为默认模型（同一时刻至多一个）。 */
  default?: boolean;
}

/**
 * v5.0 T7 模型表（官方定价页核对后：高峰 / 空闲双档 + 1M 上下文 + 并发 2500/500）。
 *
 * 单位：元 / 百万 token；每档 `offPeak` 在前、`peak` 在后。并发限制照官方口径：flash 2500 / pro 500。
 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: '默认模型：快速、便宜，适合日常对话与简单任务',
    contextWindow: 1_000_000,
    offPeak: { input: 1, output: 4.5, cacheHit: 0.02 },
    peak: { input: 2, output: 9, cacheHit: 0.04 },
    rateLimit: 2500,
    default: true,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: '复杂任务：更强的推理与编码能力',
    contextWindow: 1_000_000,
    offPeak: { input: 4.5, output: 13.5, cacheHit: 0.15 },
    peak: { input: 9.0, output: 27.0, cacheHit: 0.3 },
    rateLimit: 500,
  },
];

export function listModels(): readonly ModelProfile[] {
  return MODEL_PROFILES;
}

export function getModel(id: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((m) => m.id === id);
}

export function getDefaultModel(): ModelProfile {
  const def = MODEL_PROFILES.find((m) => m.default === true) ?? MODEL_PROFILES[0];
  if (def === undefined) {
    throw new Error('模型表为空');
  }
  return def;
}

/**
 * 当前时刻适用的价格档位（纯函数，时间注入）。
 *
 * 口径来自 `core/peak-time.ts` 的 `isPricingPeakTime`（**计价口径**，
 * 与「切 ollama」的 `isPeakTime` 独立，见 ADR-038）。
 */
export function priceTierFor(at: Date = new Date()): PriceTier {
  return isPricingPeakTime(at) ? 'peak' : 'offpeak';
}

/** 取某模型在指定档位下的价格集；未知模型抛错。 */
export function priceFor(modelId: string, tier: PriceTier): PriceSet {
  const model = getModel(modelId);
  if (model === undefined) {
    throw new Error(`未知模型: ${modelId}`);
  }
  return tier === 'peak' ? model.peak : model.offPeak;
}

/** 档位 → 中文标注（状态条 / balance 展示用）。 */
export function tierLabel(tier: PriceTier): string {
  return tier === 'peak' ? '高峰价' : '空闲价';
}

/**
 * 计算一次请求的成本（元）。
 *
 * - `inputTokens` 为总输入 token 数（含缓存命中与未命中）；
 * - `cacheHitTokens` 为其中缓存命中的 token 数，按缓存命中价格计费；
 * - `at` 决定价格档位（默认当前时刻，测试请注入固定时刻）；
 * - 未知模型 ID 抛错——调用方传入错误 ID 属于编程错误。
 */
export function costFor(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens = 0,
  at: Date = new Date(),
): number {
  const price = priceFor(modelId, priceTierFor(at));
  const missTokens = Math.max(0, inputTokens - cacheHitTokens);
  return (
    (missTokens / 1_000_000) * price.input +
    (cacheHitTokens / 1_000_000) * price.cacheHit +
    (outputTokens / 1_000_000) * price.output
  );
}

/**
 * 单独计算缓存命中 token 的成本（元）。
 */
export function cacheHitCostFor(
  modelId: string,
  cacheHitTokens: number,
  at: Date = new Date(),
): number {
  const price = priceFor(modelId, priceTierFor(at));
  return (cacheHitTokens / 1_000_000) * price.cacheHit;
}
