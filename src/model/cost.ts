/**
 * 跨 Provider 成本对比与月成本预估（v4.0 M3 T3.2 / T3.2a）。
 *
 * - compareCost：按实际 token 用量比较两个 Provider+模型的成本倍率（切换前提示）；
 * - estimateMonthlyCost：按日均对话次数估算月成本（doctor「模型推荐」区块）。
 *
 * 定价来源：
 * - DeepSeek：复用 models.ts MODEL_PROFILES（元/百万 token）；
 * - OpenAI：官方定价页（2026-08 参考，$→¥ 按 7.0 折算）；
 * - Ollama：本地模型成本 0。
 * 未知 Provider/模型 → 返回 0（不抛错，本地/未知模型无计费）。
 */

import { getModel } from './models';

/** 成本画像（元/百万 token）。 */
export interface CostProfile {
  /** 输入价格（元/百万 token，缓存未命中）。 */
  inputPricePerM: number;
  /** 输出价格（元/百万 token）。 */
  outputPricePerM: number;
  /** 输入缓存命中价格（元/百万 token）；无缓存优惠则为 undefined（= 输入价）。 */
  inputCacheHitPricePerM?: number;
}

/** OpenAI 兼容模型成本表（键 = 模型 ID；汇率 $→¥ ≈ 7.0，2026-08 参考）。 */
export const OPENAI_COST_PROFILES: Record<string, CostProfile> = {
  'gpt-4o': { inputPricePerM: 17.5, outputPricePerM: 70 },
  'gpt-4o-mini': { inputPricePerM: 1.05, outputPricePerM: 4.2 },
  'gpt-4.1': { inputPricePerM: 14.0, outputPricePerM: 56 },
  'gpt-4.1-mini': { inputPricePerM: 2.8, outputPricePerM: 11.2 },
};

/** 未知/本地模型成本（Ollama 等）。 */
const ZERO_PROFILE: CostProfile = { inputPricePerM: 0, outputPricePerM: 0 };

/** 从 Provider 名 + 模型 ID 取成本画像（deepseek 查 models.ts；openai 查 OPENAI_COST_PROFILES；其余 0）。 */
export function costProfileFor(provider: string, model: string): CostProfile {
  if (provider === 'deepseek') {
    const profile = getModel(model);
    if (profile !== undefined) {
      return {
        inputPricePerM: profile.inputPricePerM,
        outputPricePerM: profile.outputPricePerM,
        inputCacheHitPricePerM: profile.inputCacheHitPricePerM,
      };
    }
    return ZERO_PROFILE;
  }
  if (provider === 'openai') {
    return OPENAI_COST_PROFILES[model] ?? ZERO_PROFILE;
  }
  // ollama / 第三方 / 未知 → 本地或未定价，按 0 处理
  return ZERO_PROFILE;
}

/**
 * 按实际 token 用量计算成本（元）。cacheHitTokens 仅对 deepseek 缓存优惠生效。
 * 未知 Provider/模型 → 0（不抛错）。
 */
export function costForProvider(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens = 0,
): number {
  const p = costProfileFor(provider, model);
  if (p.inputPricePerM === 0 && p.outputPricePerM === 0) {
    return 0;
  }
  const missTokens = Math.max(0, inputTokens - cacheHitTokens);
  const hitPrice = p.inputCacheHitPricePerM ?? p.inputPricePerM;
  return (
    (missTokens / 1_000_000) * p.inputPricePerM +
    (Math.min(cacheHitTokens, inputTokens) / 1_000_000) * hitPrice +
    (outputTokens / 1_000_000) * p.outputPricePerM
  );
}

/**
 * 成本对比倍率：providerB 相对 providerA 的成本倍数（如 7 = B 约为 A 的 7 倍）。
 * 实际成本按 token 用量加权；A 成本为 0（本地/未知）→ 返回 0（无法比较，调用方显示「本地模型 0 成本」）。
 */
export function compareCost(
  providerA: string,
  modelA: string,
  providerB: string,
  modelB: string,
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens = 0,
): number {
  const costA = costForProvider(providerA, modelA, inputTokens, outputTokens, cacheHitTokens);
  const costB = costForProvider(providerB, modelB, inputTokens, outputTokens, cacheHitTokens);
  if (costA <= 0) {
    return 0;
  }
  return costB / costA;
}

/** 单次对话 token 用量假设（doctor 月成本预估基准；输入含系统提示 + 历史）。 */
export interface SessionTokenAssumption {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
}

/** 默认单次对话用量假设：输入 8k（含缓存命中 4k）、输出 1.2k。 */
export const DEFAULT_SESSION_TOKENS: SessionTokenAssumption = {
  inputTokens: 8_000,
  outputTokens: 1_200,
  cacheHitTokens: 4_000,
};

/**
 * 月成本预估（元）：日均 dailySessions 次对话 × 30 天。
 * @param provider Provider 名
 * @param model 模型 ID
 * @param dailySessions 日均对话次数（doctor 默认 20）
 */
export function estimateMonthlyCost(
  provider: string,
  model: string,
  dailySessions = 20,
  tokens: SessionTokenAssumption = DEFAULT_SESSION_TOKENS,
): number {
  const perSession = costForProvider(
    provider,
    model,
    tokens.inputTokens,
    tokens.outputTokens,
    tokens.cacheHitTokens,
  );
  return perSession * dailySessions * 30;
}
