/**
 * ProviderRouter 测试（v4.0 M3 T3.3/T3.4）。
 *
 * 覆盖：select/switchTo 选择切换 / chatWithFallback 故障切换（≤1 次）/ statusAll 状态。
 */

import { describe, expect, it } from 'vitest';

import type { ChatCompletionChunk } from '../../src/model/client';
import type { Provider } from '../../src/model/provider';
import { ProviderRegistry } from '../../src/model/registry';
import { ProviderRouter } from '../../src/model/router';

function fakeProvider(
  name: string,
  opts: {
    fail?: boolean;
    chunkContent?: string;
    healthOk?: boolean;
  } = {},
): Provider {
  return {
    name,
    type: name,
    defaultModel: `${name}-model`,
    streamChat: async function* () {
      if (opts.fail === true) {
        throw new Error('网络错误: ECONNREFUSED');
      }
      yield {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: name,
        choices: [{ index: 0, delta: { content: opts.chunkContent ?? '' }, finish_reason: null }],
      } as ChatCompletionChunk;
    },
    tokenize: (text) => text.length,
    cost: () => 0,
    healthCheck: async () => ({
      ok: opts.healthOk ?? true,
      latencyMs: 1,
      error: opts.healthOk === false ? 'down' : undefined,
    }),
  };
}

describe('ProviderRouter', () => {
  it('select：按名 / undefined → 默认', () => {
    const registry = new ProviderRegistry();
    const a = fakeProvider('a');
    const b = fakeProvider('b');
    registry.register(a);
    registry.register(b);
    const router = new ProviderRouter(registry);
    expect(router.select('b')?.name).toBe('b');
    expect(router.select(undefined)?.name).toBe('a'); // 默认 = 第一个
    expect(router.select('unknown')).toBeUndefined();
  });

  it('switchTo：切换默认 + 未知不生效', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('a'));
    registry.register(fakeProvider('b'));
    const router = new ProviderRouter(registry);
    expect(router.switchTo('b')?.name).toBe('b');
    expect(registry.defaultName()).toBe('b');
    expect(router.switchTo('unknown')).toBeUndefined();
    expect(registry.defaultName()).toBe('b');
  });

  it('chatWithFallback：主 Provider 成功 → 不 fallback，内容完整透传', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('deepseek', { chunkContent: 'hello' }));
    registry.register(fakeProvider('ollama', { chunkContent: 'fallback' }));
    registry.setDefault('ollama');
    const router = new ProviderRouter(registry);
    const primary = registry.get('deepseek') as Provider;
    const result = await router.chatWithFallback(primary, {
      model: 'deepseek-v4-flash',
      messages: [],
    });
    expect(result.fellBack).toBe(false);
    expect(result.provider.name).toBe('deepseek');
    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      const content = chunk.choices[0]?.delta.content ?? '';
      if (content !== '') chunks.push(content);
    }
    expect(chunks).toEqual(['hello']);
  });

  it('chatWithFallback：主 Provider 首字节前失败 → 切备选（fellBack=true）', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('deepseek', { fail: true }));
    registry.register(fakeProvider('ollama', { chunkContent: 'fallback-ok' }));
    registry.setDefault('ollama');
    const router = new ProviderRouter(registry);
    const primary = registry.get('deepseek') as Provider;
    const result = await router.chatWithFallback(primary, {
      model: 'deepseek-v4-flash',
      messages: [],
    });
    expect(result.fellBack).toBe(true);
    expect(result.provider.name).toBe('ollama');
    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      const content = chunk.choices[0]?.delta.content ?? '';
      if (content !== '') chunks.push(content);
    }
    expect(chunks).toEqual(['fallback-ok']);
  });

  it('chatWithFallback：主 Provider 即默认 → 无备选（直接透传）', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('deepseek', { chunkContent: 'x' }));
    const router = new ProviderRouter(registry);
    const primary = registry.get('deepseek') as Provider;
    const result = await router.chatWithFallback(primary, {
      model: 'm',
      messages: [],
    });
    expect(result.fellBack).toBe(false);
    expect(result.provider.name).toBe('deepseek');
  });

  it('chatWithFallback：非网络错误不 fallback（原样上抛）', async () => {
    const registry = new ProviderRegistry();
    const bad = fakeProvider('deepseek', { fail: true });
    // 覆写为编程错误（不含网络关键词）
    const badProvider: Provider = {
      ...bad,
      streamChat: async function* () {
        // 首字节前抛非网络错误（编程错误，不应触发 fallback）
        await Promise.reject(new Error('Invalid JSON'));
        yield {} as ChatCompletionChunk; // 不可达
      },
    };
    registry.register(badProvider);
    registry.register(fakeProvider('ollama'));
    registry.setDefault('ollama');
    const router = new ProviderRouter(registry);
    await expect(
      router.chatWithFallback(badProvider, { model: 'm', messages: [] }),
    ).rejects.toThrow('Invalid JSON');
  });

  it('statusAll：健康/不健康 Provider 状态正确', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('ok', { healthOk: true }));
    registry.register(fakeProvider('down', { healthOk: false }));
    const router = new ProviderRouter(registry);
    const statuses = await router.statusAll();
    expect(statuses).toHaveLength(2);
    expect(statuses.find((s) => s.provider.name === 'ok')?.status).toBe('ok');
    expect(statuses.find((s) => s.provider.name === 'down')?.status).toBe('unavailable');
  });

  it('resolveStartupProvider：主 Provider 健康 → 保持（不 fallback）', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('deepseek', { healthOk: true }));
    registry.register(fakeProvider('ollama', { healthOk: true }));
    registry.setDefault('ollama');
    const router = new ProviderRouter(registry);
    const result = await router.resolveStartupProvider('deepseek', {
      healthCheckTimeoutMs: 100,
    });
    expect(result.fellBack).toBe(false);
    expect(result.provider.name).toBe('deepseek');
  });

  it('resolveStartupProvider：主 Provider 故障 + 备选可用 → 自动切换（T3.4）', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('deepseek', { healthOk: false }));
    registry.register(fakeProvider('ollama', { healthOk: true }));
    registry.setDefault('ollama');
    const router = new ProviderRouter(registry);
    const result = await router.resolveStartupProvider('deepseek', {
      healthCheckTimeoutMs: 100,
    });
    expect(result.fellBack).toBe(true);
    expect(result.provider.name).toBe('ollama');
    expect(result.reason).toBeDefined();
  });

  it('resolveStartupProvider：主 Provider 即默认（无备选）→ 不探测不切换', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('deepseek', { healthOk: false }));
    const router = new ProviderRouter(registry);
    const result = await router.resolveStartupProvider('deepseek', {
      healthCheckTimeoutMs: 100,
    });
    expect(result.fellBack).toBe(false);
    expect(result.provider.name).toBe('deepseek');
  });

  it('resolveStartupProvider：主备都故障 → 保持主 Provider（不切来切去）', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('deepseek', { healthOk: false }));
    registry.register(fakeProvider('ollama', { healthOk: false }));
    registry.setDefault('ollama');
    const router = new ProviderRouter(registry);
    const result = await router.resolveStartupProvider('deepseek', {
      healthCheckTimeoutMs: 100,
    });
    expect(result.fellBack).toBe(false);
    expect(result.provider.name).toBe('deepseek');
  });

  it('resolveStartupProvider：空注册表 → 抛错', async () => {
    const registry = new ProviderRegistry();
    const router = new ProviderRouter(registry);
    await expect(
      router.resolveStartupProvider('deepseek', { healthCheckTimeoutMs: 100 }),
    ).rejects.toThrow('No provider registered');
  });
});
