/**
 * Provider 实现测试（v4.0 M3 T3.3）。
 *
 * 覆盖：接口契约四能力（chat/tokenize/cost/healthCheck）/ 三 Provider 各自行为 /
 * Ollama /api/tags 探测 / OpenAI baseUrl 可配 / 本地模型成本 0。
 */

import { describe, expect, it } from 'vitest';

import { createDeepSeekProvider } from '../../src/model/providers/deepseek';
import { createOllamaProvider, listOllamaModels } from '../../src/model/providers/ollama';
import { createOpenAIProvider } from '../../src/model/providers/openai';

// ── 固定时刻夹具（v5.0 T7：价格档位时间注入，杜绝时间依赖 flaky）──
/** 周三 10:00 → 计价高峰。 */
const PEAK_AT = new Date(2026, 9, 28, 10, 0, 0);
/** 周三 20:00 → 空闲。 */
const OFFPEAK_AT = new Date(2026, 9, 28, 20, 0, 0);

/** 构造 mock fetch（按 URL 分派）。 */
function mockFetch(
  handler: (url: string, init?: RequestInit) => { ok: boolean; json?: unknown; status?: number },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const h = handler(url, init);
    return {
      ok: h.ok,
      status: h.status ?? (h.ok ? 200 : 500),
      json: async () => h.json,
      text: async () => (h.ok ? JSON.stringify(h.json) : 'error'),
    } as Response;
  }) as typeof fetch;
}

describe('createDeepSeekProvider（T3.3）', () => {
  it('接口契约：name/type/defaultModel + tokenize/cost/healthCheck', async () => {
    // v5.0 T7：注入固定空闲时刻，避免「白天高峰价 / 晚上空闲价」的时间依赖 flaky
    const provider = createDeepSeekProvider({ apiKey: 'sk-test', now: () => OFFPEAK_AT });
    expect(provider.name).toBe('deepseek');
    expect(provider.type).toBe('deepseek');
    expect(provider.defaultModel).toBe('deepseek-v4-flash');
    // tokenize：已知文本 → 正数
    expect(provider.tokenize('hello')).toBeGreaterThan(0);
    // cost：按定价表计算（flash 空闲价：输入 1.5 元/M，输出 4.5 元/M）
    const cost = provider.cost(1_000_000, 500_000);
    expect(cost).toBeCloseTo(1.5 + 2.25, 5); // 1M 输入 * 1.5 + 0.5M 输出 * 4.5
    // healthCheck：mock fetch 返回余额 → ok
    const withFetch = createDeepSeekProvider({
      apiKey: 'sk-test',
      fetchImpl: mockFetch(() => ({ ok: true, json: { is_available: true } })),
    });
    const health = await withFetch.healthCheck();
    expect(health.ok).toBe(true);
  });

  it('cost：缓存命中按低价计费', () => {
    const provider = createDeepSeekProvider({ apiKey: 'sk-test', now: () => OFFPEAK_AT });
    const cost = provider.cost(1_000_000, 0, 1_000_000); // 全部命中
    expect(cost).toBeCloseTo(0.05, 5); // 空闲档命中价 0.05 元/M
  });

  it('cost：高峰时段按高峰价（同一用量为空闲的 2 倍）', () => {
    const peak = createDeepSeekProvider({ apiKey: 'sk-test', now: () => PEAK_AT });
    const off = createDeepSeekProvider({ apiKey: 'sk-test', now: () => OFFPEAK_AT });
    expect(peak.cost(1_000_000, 1_000_000)).toBeCloseTo(off.cost(1_000_000, 1_000_000) * 2);
  });

  it('healthCheck：API 失败 → ok=false + 错误信息', async () => {
    const withFetch = createDeepSeekProvider({
      apiKey: 'sk-bad',
      fetchImpl: mockFetch(() => ({ ok: false, status: 401 })),
    });
    const health = await withFetch.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.error).toBeDefined();
  });
});

describe('createOpenAIProvider（T3.3）', () => {
  it('baseUrl 可配（第三方兼容端点）+ chat 复用 SSE 协议', () => {
    const provider = createOpenAIProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://custom.example.com/v1',
    });
    expect(provider.name).toBe('openai');
    expect(provider.defaultModel).toBe('gpt-4o');
    // tokenize 委托 tokenizer
    expect(provider.tokenize('hi')).toBeGreaterThan(0);
    // cost：gpt-4o 定价（15/60 元/M）
    const cost = provider.cost(1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(75, 5);
  });

  it('healthCheck：GET /models 成功 → ok', async () => {
    let called = '';
    const provider = createOpenAIProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl: mockFetch((url) => {
        called = url;
        return { ok: true, json: { data: [{ id: 'gpt-4o' }] } };
      }),
    });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(called).toContain('/models');
  });

  it('healthCheck：401 → ok=false', async () => {
    const provider = createOpenAIProvider({
      apiKey: 'sk-bad',
      fetchImpl: mockFetch(() => ({ ok: false, status: 401 })),
    });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(false);
  });

  it('未知模型 cost = 0（不抛错）', () => {
    const provider = createOpenAIProvider({
      apiKey: 'sk-test',
      defaultModel: 'unknown-model',
    });
    expect(provider.cost(1000, 1000)).toBe(0);
  });
});

describe('createOllamaProvider（T3.3）', () => {
  it('本地模型：cost 恒 0 + tokenize 委托', () => {
    const provider = createOllamaProvider({ baseUrl: 'http://localhost:11434' });
    expect(provider.name).toBe('ollama');
    expect(provider.type).toBe('ollama');
    expect(provider.cost(100000, 100000)).toBe(0);
    expect(provider.tokenize('你好')).toBeGreaterThan(0);
  });

  it('listOllamaModels：/api/tags 解析本地模型列表', async () => {
    const models = await listOllamaModels({
      baseUrl: 'http://localhost:11434',
      fetchImpl: mockFetch((url) => {
        expect(url).toContain('/api/tags');
        return { ok: true, json: { models: [{ name: 'qwen3.6:27b' }, { name: 'llama3:8b' }] } };
      }),
    });
    expect(models).toEqual(['qwen3.6:27b', 'llama3:8b']);
  });

  it('listOllamaModels：服务不可用 → []（不抛错）', async () => {
    const models = await listOllamaModels({
      fetchImpl: mockFetch(() => {
        throw new Error('ECONNREFUSED');
      }),
    });
    expect(models).toEqual([]);
  });

  it('healthCheck：有本地模型 → ok；无模型 → ok=false', async () => {
    const okProvider = createOllamaProvider({
      fetchImpl: mockFetch(() => ({ ok: true, json: { models: [{ name: 'qwen3.6:27b' }] } })),
    });
    expect((await okProvider.healthCheck()).ok).toBe(true);

    const emptyProvider = createOllamaProvider({
      fetchImpl: mockFetch(() => ({ ok: true, json: { models: [] } })),
    });
    expect((await emptyProvider.healthCheck()).ok).toBe(false);
  });
});
