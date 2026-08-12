/**
 * OpenAI Provider（v4.0 M3 T3.3）。
 *
 * 复用 DeepSeekClient 的 SSE 流式协议（OpenAI 兼容 /v1/chat/completions），
 * baseUrl 可配（支持第三方 OpenAI 兼容 API）。
 * 定价表：内置 OpenAI 模型定价（gpt-4o / gpt-4o-mini，2026-08 常见公开价）；
 * 第三方 baseUrl 未知模型返回 0。
 * healthCheck：GET /models（OpenAI 兼容端点普遍支持）。
 */

import { DeepSeekClient } from '../client';
import type { Provider } from '../provider';
import { countTokens } from '../tokenizer';

/** OpenAI 兼容 API 默认端点。 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** OpenAI 默认模型。 */
export const OPENAI_DEFAULT_MODEL = 'gpt-4o';

/** OpenAI 内置定价表（元 / 百万 token；2026-08 公开常见价，第三方 baseUrl 可覆盖）。 */
const OPENAI_PRICING: Record<string, { input: number; output: number; cacheHit?: number }> = {
  'gpt-4o': { input: 15.0, output: 60.0, cacheHit: 7.5 },
  'gpt-4o-mini': { input: 1.5, output: 6.0, cacheHit: 0.75 },
};

export interface OpenAIProviderOptions {
  /** API Key（必填）。 */
  apiKey: string;
  /** baseUrl（默认 https://api.openai.com/v1；第三方兼容端点覆盖）。 */
  baseUrl?: string;
  /** Provider 名（默认 'openai'）。 */
  name?: string;
  /** 默认模型 ID（缺省 OPENAI_DEFAULT_MODEL）。 */
  defaultModel?: string;
  /** 定价表（默认 OPENAI_PRICING；第三方可注入）。 */
  pricing?: Record<string, { input: number; output: number; cacheHit?: number }>;
  /** fetch 实现（healthCheck 注入；默认 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
  /** 连接超时（毫秒，默认 30_000）。 */
  timeoutMs?: number;
}

/** 构建 OpenAI Provider（复用 DeepSeekClient 的 SSE 流式实现，baseUrl 指向 OpenAI 兼容端点）。 */
export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
  const name = options.name ?? 'openai';
  const defaultModel = options.defaultModel ?? OPENAI_DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
  const pricing = options.pricing ?? OPENAI_PRICING;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  // DeepSeekClient 即 OpenAI 兼容 SSE 客户端；baseUrl 指向 OpenAI 端点即可复用
  const client = new DeepSeekClient({
    apiKey: options.apiKey,
    baseUrl,
    timeoutMs: options.timeoutMs,
  });

  return {
    name,
    type: 'openai',
    defaultModel,
    streamChat: (params) => client.streamChat(params),
    tokenize: (text) => countTokens(text),
    cost: (inputTokens, outputTokens, cacheHitTokens = 0) => {
      const model = pricing[defaultModel];
      if (model === undefined) {
        return 0;
      }
      return (
        (Math.max(0, inputTokens - cacheHitTokens) / 1_000_000) * model.input +
        (cacheHitTokens / 1_000_000) * (model.cacheHit ?? model.input) +
        (outputTokens / 1_000_000) * model.output
      );
    },
    healthCheck: async () => {
      const start = performance.now();
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
          headers: { Authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          return {
            ok: false,
            latencyMs: Math.round(performance.now() - start),
            error: `HTTP ${response.status}`,
          };
        }
        return { ok: true, latencyMs: Math.round(performance.now() - start) };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
