/**
 * 模型表与成本计算。
 *
 * 数据来源：DeepSeek 官方定价页（2026-08-07 核实）
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */

export interface ModelProfile {
  /** API 请求使用的模型 ID。 */
  id: string;
  /** 中文展示名。 */
  label: string;
  /** 用途说明。 */
  description: string;
  /** 上下文窗口大小（token）。 */
  contextWindow: number;
  /** 输入价格（元 / 百万 token，缓存未命中）。 */
  inputPricePerM: number;
  /** 输出价格（元 / 百万 token）。 */
  outputPricePerM: number;
  /** 输入价格（元 / 百万 token，缓存命中）。 */
  inputCacheHitPricePerM: number;
  /** API 并发限制。 */
  rateLimit: number;
  /** 是否为默认模型（同一时刻至多一个）。 */
  default?: boolean;
}

/** v1.0 模型表。数据来源：DeepSeek 官方定价页（2026-08-07 核实）。 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: '默认模型：快速、便宜，适合日常对话与简单任务',
    contextWindow: 1_000_000,
    inputPricePerM: 1.0,
    outputPricePerM: 2.0,
    inputCacheHitPricePerM: 0.02,
    rateLimit: 2500,
    default: true,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: '复杂任务：更强的推理与编码能力',
    contextWindow: 1_000_000,
    inputPricePerM: 3.0,
    outputPricePerM: 6.0,
    inputCacheHitPricePerM: 0.025,
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
 * 计算一次请求的成本（元）。
 *
 * - `inputTokens` 为总输入 token 数（含缓存命中与未命中）；
 * - `cacheHitTokens` 为其中缓存命中的 token 数，按缓存命中价格计费；
 * - 未知模型 ID 抛错——调用方传入错误 ID 属于编程错误。
 */
export function costFor(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens = 0,
): number {
  const model = getModel(modelId);
  if (model === undefined) {
    throw new Error(`未知模型: ${modelId}`);
  }
  const missTokens = Math.max(0, inputTokens - cacheHitTokens);
  return (
    (missTokens / 1_000_000) * model.inputPricePerM +
    (cacheHitTokens / 1_000_000) * model.inputCacheHitPricePerM +
    (outputTokens / 1_000_000) * model.outputPricePerM
  );
}

/**
 * 单独计算缓存命中 token 的成本（元）。
 */
export function cacheHitCostFor(modelId: string, cacheHitTokens: number): number {
  const model = getModel(modelId);
  if (model === undefined) {
    throw new Error(`未知模型: ${modelId}`);
  }
  return (cacheHitTokens / 1_000_000) * model.inputCacheHitPricePerM;
}
