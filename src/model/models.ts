/**
 * 模型表与成本计算。
 *
 * 注意：模型 ID 与定价为开发期暂定值，
 * 发布前需核实官方最新模型 ID 与定价（见 docs/dev/TASKS.md 开放问题）。
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
  /** 输入价格（元 / 百万 token）。TODO: 发布前核实。 */
  inputPricePerM: number;
  /** 输出价格（元 / 百万 token）。TODO: 发布前核实。 */
  outputPricePerM: number;
  /** 是否为默认模型（同一时刻至多一个）。 */
  default?: boolean;
}

/** v0.1 模型表。价格参考历史 DeepSeek 定价暂定，发布前核实。 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: '默认模型：快速、便宜，适合日常对话与简单任务',
    contextWindow: 128_000,
    inputPricePerM: 1.0,
    outputPricePerM: 4.0,
    default: true,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: '复杂任务：更强的推理与编码能力',
    contextWindow: 128_000,
    inputPricePerM: 8.0,
    outputPricePerM: 32.0,
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
 * 未知模型 ID 抛错——调用方传入错误 ID 属于编程错误。
 */
export function costFor(modelId: string, inputTokens: number, outputTokens: number): number {
  const model = getModel(modelId);
  if (model === undefined) {
    throw new Error(`未知模型: ${modelId}`);
  }
  return (
    (inputTokens / 1_000_000) * model.inputPricePerM +
    (outputTokens / 1_000_000) * model.outputPricePerM
  );
}
