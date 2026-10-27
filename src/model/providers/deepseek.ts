/**
 * DeepSeek Provider（v4.0 M3 T3.3 / v5.0 T7 双档计价）。
 *
 * 包装现有 DeepSeekClient（SSE 流式 + 重试 + 超时），补充 tokenize / cost / healthCheck。
 * 定价复用 `MODEL_PROFILES`（高峰 / 空闲双档），**不在此处重复维护价格**。
 * healthCheck：GET /user/balance（复用 balance/fetchBalance，只读轻量）。
 */

import { fetchBalance } from '../../balance';
import { DeepSeekClient, type DeepSeekClientOptions } from '../client';
import { costFor } from '../models';
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
  /**
   * 时钟（v5.0 T7）：决定计价档位（高峰 / 空闲）。
   *
   * Provider 的 `cost()` 是既有接口（`(input, output, cacheHit?) => number`），无法追加时刻参数，
   * 因此时钟在构造时注入——默认 `() => new Date()`，测试注入固定时刻以避免
   * 「白天跑高峰价、晚上跑空闲价」的时间依赖型 flaky。
   */
  now?: () => Date;
}

/** 构建 DeepSeek Provider（chat 复用 DeepSeekClient；tokenize/cost/healthCheck 补齐）。 */
export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}): Provider {
  const client = new DeepSeekClient({ apiKey: options.apiKey ?? '', ...options });
  const name = options.name ?? 'deepseek';
  const defaultModel = options.defaultModel ?? DEEPSEEK_DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  return {
    name,
    type: 'deepseek',
    defaultModel,
    streamChat: (params) => client.streamChat(params),
    tokenize: (text) => countTokens(text),
    // v5.0 T7：复用 models.ts 的双档计价（避免此处重复维护价格，防两处漂移）
    cost: (inputTokens, outputTokens, cacheHitTokens = 0) => {
      try {
        return costFor(defaultModel, inputTokens, outputTokens, cacheHitTokens, now());
      } catch {
        // 未知模型（自定义 defaultModel）→ 0，不抛错
        return 0;
      }
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
