/**
 * 智能模型推荐（v4.0 M3 T3.2）：doctor「模型推荐」区块。
 *
 * 输入启发式：
 * - 项目复杂度（文件数/依赖数等）：small / medium / large；
 * - 预算档位（config 或 CLI）：low / medium / high；
 * - 本地 Ollama 可用性（/api/tags 探测）。
 *
 * 推荐规则（2026-08 定价参考）：
 * - 预算 low + 本地可用 → ollama（成本 0，可离线）；
 * - 预算 low + 无本地 → deepseek（deepseek-chat 低价位）；
 * - 预算 medium → deepseek（默认组合，成本/质量均衡）；
 * - 预算 high + 项目 large → openai gpt-4o（最强模型，成本最高）；
 * - 预算 high + 项目 small/medium → deepseek 高性能档或 openai gpt-4o-mini。
 *
 * 月成本预估：estimateMonthlyCost（日均 20 次对话，默认 token 假设）。
 */

import { estimateMonthlyCost } from './cost';

/** 项目复杂度（启发式档位）。 */
export type ProjectComplexity = 'small' | 'medium' | 'large';

/** 预算档位（月成本承受力）。 */
export type BudgetLevel = 'low' | 'medium' | 'high';

/** 推荐输入。 */
export interface RecommendInput {
  /** 项目复杂度（doctor 检测文件数/依赖数得出；默认 medium）。 */
  complexity?: ProjectComplexity;
  /** 预算档位（config 或 CLI；默认 medium）。 */
  budget?: BudgetLevel;
  /** 本地 Ollama 是否可用（/api/tags 探测；默认 false）。 */
  localAvailable?: boolean;
  /** 日均对话次数（月成本预估基准；默认 20）。 */
  dailySessions?: number;
}

/** 推荐结果。 */
export interface RecommendResult {
  /** 推荐 Provider 名（deepseek / openai / ollama）。 */
  provider: string;
  /** 推荐模型 ID。 */
  model: string;
  /** 月成本预估（元；ollama 为 0）。 */
  monthlyCost: number;
  /** 推荐理由（i18n 文案键或已本地化文本）。 */
  reason: string;
}

/** 复杂度检测：按项目文件数与依赖数启发式（doctor 调用；文件数超过阈值升档）。 */
export function detectComplexity(options: {
  fileCount?: number;
  dependencyCount?: number;
}): ProjectComplexity {
  const files = options.fileCount ?? 0;
  const deps = options.dependencyCount ?? 0;
  if (files > 300 || deps > 80) return 'large';
  if (files > 60 || deps > 15) return 'medium';
  return 'small';
}

/** 默认推荐参数。 */
const DEFAULT_INPUT: Required<Pick<RecommendInput, 'complexity' | 'budget'>> = {
  complexity: 'medium',
  budget: 'medium',
};

/** 推荐模型组合（预算 × 复杂度 → 目标组合；本地可用时优先覆盖为 ollama）。 */
function pickTarget(input: RecommendInput): { provider: string; model: string; reasonKey: string } {
  const complexity = input.complexity ?? DEFAULT_INPUT.complexity;
  const budget = input.budget ?? DEFAULT_INPUT.budget;

  // 预算 low：成本优先——本地可用 → ollama（0 成本）；否则 deepseek 低价模型（v4-flash 最便宜）
  if (budget === 'low') {
    if (input.localAvailable === true) {
      return { provider: 'ollama', model: 'qwen3.6:27b-q4_K_M', reasonKey: 'lowLocal' };
    }
    return { provider: 'deepseek', model: 'deepseek-v4-flash', reasonKey: 'lowCloud' };
  }

  // 预算 medium：均衡——默认 DeepSeek（成本/质量均衡，v4-flash 官方默认）
  if (budget === 'medium') {
    return { provider: 'deepseek', model: 'deepseek-v4-flash', reasonKey: 'medium' };
  }

  // 预算 high：质量优先——复杂项目 → gpt-4o；轻量项目 → gpt-4o-mini（性价比高）
  if (complexity === 'large') {
    return { provider: 'openai', model: 'gpt-4o', reasonKey: 'highLarge' };
  }
  return { provider: 'openai', model: 'gpt-4o-mini', reasonKey: 'highSmall' };
}

/** 执行推荐；返回推荐组合 + 月成本 + 理由。 */
export function recommendProvider(input: RecommendInput = {}): RecommendResult {
  const target = pickTarget(input);
  const dailySessions = input.dailySessions ?? 20;
  const monthlyCost = estimateMonthlyCost(target.provider, target.model, dailySessions);
  return {
    provider: target.provider,
    model: target.model,
    monthlyCost,
    reason: target.reasonKey,
  };
}
