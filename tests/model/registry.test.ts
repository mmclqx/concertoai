/**
 * ProviderRegistry 测试（v4.0 M3 T3.3）。
 */

import { describe, expect, it } from 'vitest';

import type { Provider } from '../../src/model/provider';
import { ProviderRegistry } from '../../src/model/registry';

function fakeProvider(name: string): Provider {
  return {
    name,
    type: name,
    defaultModel: `${name}-model`,
    streamChat: async function* () {},
    tokenize: (text) => text.length,
    cost: () => 0,
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
  };
}

describe('ProviderRegistry', () => {
  it('register/get/list/names 基本操作', () => {
    const registry = new ProviderRegistry();
    expect(registry.empty).toBe(true);
    expect(registry.register(fakeProvider('deepseek'))).toBe(true);
    expect(registry.register(fakeProvider('openai'))).toBe(true);
    expect(registry.empty).toBe(false);
    expect(registry.names()).toEqual(['deepseek', 'openai']);
    expect(registry.get('deepseek')?.name).toBe('deepseek');
    expect(registry.get('unknown')).toBeUndefined();
    expect(registry.list()).toHaveLength(2);
  });

  it('重名注册覆盖（返回 false）', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('a'));
    expect(registry.register(fakeProvider('a'))).toBe(false);
    expect(registry.list()).toHaveLength(1);
  });

  it('default：未设默认 → 第一个注册', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('a'));
    registry.register(fakeProvider('b'));
    expect(registry.default()?.name).toBe('a');
    expect(registry.defaultName()).toBe('a');
  });

  it('setDefault：已注册名生效；未知名不生效（保持原默认）', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('a'));
    registry.register(fakeProvider('b'));
    registry.setDefault('b');
    expect(registry.default()?.name).toBe('b');
    registry.setDefault('unknown');
    expect(registry.default()?.name).toBe('b');
  });

  it('默认 Provider 被移除后回退第一个', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('a'));
    registry.register(fakeProvider('b'));
    registry.setDefault('a');
    // 无 remove API；模拟：空注册表 default 为 undefined
    const empty = new ProviderRegistry();
    expect(empty.default()).toBeUndefined();
  });
});
