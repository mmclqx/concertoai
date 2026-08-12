/**
 * DeepSeek Provider（v4.0 M3 T3.3）。
 *
 * 包装现有 DeepSeekClient（SSE 流式 + 重试 + 超时），补充 tokenize / cost / healthCheck。
 * 定价表复用 MODEL_PROFILES（官方定价 2026-08 核实）。
 * healthCheck：GET /user/balance（复用 balance/fetchBalance，只读轻量）。
 */

import { fetchBalance } from '../../balance';
import { DeepSeekClient, type DeepSeekClientOptions } from '../client';
import { getModel } from '../models';
import type { Provider } from '../provider';
import { countTokens } from '../tokenizer';

/** DeepSeek Provider 默认模型。 */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

export interface DeepSeekProviderOptions extends Omit<DeepSeekClientOptions, 'apiKey'> {
  /** API Key（缺省空串——healthCheck 会失败，状态显示 🔴；auth 后由 accounts 注入）。 */
  apiKey?: string;
  /** Provider 名（默认 'deepseek'）。 */
  name?: string;
  /** 默认模型 ID（缺省 DEEPSEEK_DEFAULT_MODEL）。 */
  defaultModel?: string;
  /** fetch 实现（healthCheck 注入；默认 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
}

/** 构建 DeepSeek Provider（chat 复用 DeepSeekClient；tokenize/cost/healthCheck 补齐）。 */
export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}): Provider {
  const client = new DeepSeekClient({ apiKey: options.apiKey ?? '', ...options });
  const name = options.name ?? 'deepseek';
  const defaultModel = options.defaultModel ?? DEEPSEEK_DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    name,
    type: 'deepseek',
    defaultModel,
    streamChat: (params) => client.streamChat(params),
    tokenize: (text) => countTokens(text),
    cost: (inputTokens, outputTokens, cacheHitTokens = 0) => {
      const profile = getModel(defaultModel);
      if (profile === undefined) {
        return 0;
      }
      return (
        (Math.max(0, inputTokens - cacheHitTokens) / 1_000_000) * profile.inputPricePerM +
        (cacheHitTokens / 1_000_000) * profile.inputCacheHitPricePerM +
        (outputTokens / 1_000_000) * profile.outputPricePerM
      );
    },
    healthCheck: async () => {
      const start = performance.now();
      try {
        await fetchBalance(options.apiKey ?? '', {
          baseUrl: options.baseUrl,
          fetchImpl,
        });
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
