/**
 * Ollama Provider（v4.0 M3 T3.3）。
 *
 * 本地模型：OpenAI 兼容端点（/v1/chat/completions），自动探测本地模型列表
 * （GET /api/tags），provider list 中显示。无 API Key（本地服务免鉴权）。
 * 成本恒为 0（本地推理不计费）。
 * healthCheck：GET /api/tags 探测服务可用 + 返回模型数。
 */

import { DeepSeekClient } from '../client';
import type { Provider } from '../provider';
import { countTokens } from '../tokenizer';

/** Ollama 默认端点。 */
export const OLLAMA_BASE_URL = 'http://localhost:11434';

/** Ollama 默认模型（与 config DEFAULT_OLLAMA_MODEL 对齐）。 */
export const OLLAMA_DEFAULT_MODEL = 'qwen3.6:27b-q4_K_M';

export interface OllamaProviderOptions {
  /** baseUrl（默认 http://localhost:11434；注意 /api 与 /v1 路径差异在内部处理）。 */
  baseUrl?: string;
  /** Provider 名（默认 'ollama'）。 */
  name?: string;
  /** 默认模型 ID（缺省 OLLAMA_DEFAULT_MODEL）。 */
  defaultModel?: string;
  /** fetch 实现（healthCheck 注入；默认 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
}

/** /api/tags 响应（本地模型列表）。 */
export interface OllamaTagsResponse {
  models?: Array<{ name: string; model?: string; size?: number }>;
  error?: string;
}

/** 探测本地模型列表；失败返回 []（不抛错，供 provider list 降级显示）。 */
export async function listOllamaModels(
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  const baseUrl = options.baseUrl ?? OLLAMA_BASE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as OllamaTagsResponse;
    if (data.error !== undefined) {
      return [];
    }
    return (data.models ?? []).map((m) => m.name).filter((n) => n !== '');
  } catch {
    return [];
  }
}

/** 构建 Ollama Provider（chat 复用 DeepSeekClient SSE，指向 /v1；本地免鉴权）。 */
export function createOllamaProvider(options: OllamaProviderOptions = {}): Provider {
  const name = options.name ?? 'ollama';
  const defaultModel = options.defaultModel ?? OLLAMA_DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? OLLAMA_BASE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  // Ollama OpenAI 兼容端点为 /v1/chat/completions；baseUrl 规范化（尾部 /v1 不重复）
  const v1Base = baseUrl.replace(/\/$/, '').endsWith('/v1')
    ? baseUrl.replace(/\/$/, '')
    : `${baseUrl.replace(/\/$/, '')}/v1`;

  const client = new DeepSeekClient({
    apiKey: 'ollama', // 本地免鉴权；DeepSeekClient 要求非空 key，用占位
    baseUrl: v1Base,
  });

  return {
    name,
    type: 'ollama',
    defaultModel,
    streamChat: (params) => client.streamChat(params),
    tokenize: (text) => countTokens(text),
    cost: () => 0, // 本地模型不计费
    healthCheck: async () => {
      const start = performance.now();
      try {
        const models = await listOllamaModels({ baseUrl, fetchImpl });
        return {
          ok: models.length > 0,
          latencyMs: Math.round(performance.now() - start),
          error: models.length === 0 ? 'Ollama 服务不可用或未安装本地模型' : undefined,
        };
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
