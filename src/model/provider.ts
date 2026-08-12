/**
 * Provider 抽象接口（v4.0 M3 T3.3）。
 *
 * 四能力契约：
 * - chat：流式对话补全（复用现有 ChatCompletionChunk 协议，DeepSeek/OpenAI/Ollama
 *   统一返回该形态，跨 Provider 差异在实现内适配）；
 * - tokenize：文本 token 计数（BPE 精确计数，失败降级估算）；
 * - cost：一次请求成本（元，按 Provider 定价表；本地/未知模型返回 0）；
 * - healthCheck：轻量可用性探测（DeepSeek/OpenAI 调 /models 或余额、Ollama 调 /api/tags），
 *   返回 { ok, latencyMs }，供 provider list 状态与 fallback 判断。
 *
 * 设计原则（ADR-034 / D54）：
 * - 用户侧 --provider / config 自由切换（切换前显示成本对比）；
 * - Orchestrator/团队闭环内部固定默认 Provider（避免跨模型通信）；
 * - fallback 仅失败重试（≤1 次）。
 */

import type { ChatCompletionChunk, StreamChatParams } from './client';

// ── 类型 ──────────────────────────────────────────────────────

/** 健康检查结果。 */
export interface HealthCheckResult {
  /** 是否可用。 */
  ok: boolean;
  /** 探测耗时（毫秒）。 */
  latencyMs: number;
  /** 失败原因（ok=false 时）。 */
  error?: string;
}

/** 成本信息（元）。 */
export interface CostBreakdown {
  /** 输入 token 数（含缓存命中与未命中）。 */
  inputTokens: number;
  /** 输出 token 数。 */
  outputTokens: number;
  /** 缓存命中 token 数。 */
  cacheHitTokens: number;
  /** 总成本（元）。 */
  cost: number;
}

/** Provider 状态（provider list 展示）。 */
export type ProviderStatus = 'ok' | 'unavailable' | 'degraded';

/** Provider 接口：四能力契约。 */
export interface Provider {
  /** Provider 名（唯一键，registry 定位；如 deepseek / openai / ollama）。 */
  readonly name: string;
  /** Provider 类型（deepseek / openai / ollama 或第三方兼容）。 */
  readonly type: string;
  /** 默认模型 ID（config 未指定时用）。 */
  readonly defaultModel: string;
  /** 流式对话补全。 */
  streamChat(params: StreamChatParams): AsyncGenerator<ChatCompletionChunk>;
  /** 文本 token 计数（精确 BPE，失败降级估算）。 */
  tokenize(text: string): number;
  /** 一次请求成本（元）；未知模型/本地模型返回 0（不抛错）。 */
  cost(inputTokens: number, outputTokens: number, cacheHitTokens?: number): number;
  /** 轻量可用性探测。 */
  healthCheck(): Promise<HealthCheckResult>;
}

// ── 通用工具 ──────────────────────────────────────────────────

/** 成本计算辅助：按定价表计算（模型不在表内返回 0，不抛错——本地/未知模型无计费）。 */
export function costFromProfile(
  inputPricePerM: number | undefined,
  outputPricePerM: number | undefined,
  inputCacheHitPricePerM: number | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens = 0,
): number {
  if (inputPricePerM === undefined || outputPricePerM === undefined) {
    return 0;
  }
  const missTokens = Math.max(0, inputTokens - cacheHitTokens);
  const inputCost = (missTokens / 1_000_000) * inputPricePerM;
  const hitCost =
    inputCacheHitPricePerM === undefined
      ? 0
      : (Math.min(cacheHitTokens, inputTokens) / 1_000_000) * inputCacheHitPricePerM;
  return inputCost + hitCost + (outputTokens / 1_000_000) * outputPricePerM;
}
