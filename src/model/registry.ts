/**
 * ProviderRegistry（v4.0 M3 T3.3）：Provider 注册/发现/默认。
 *
 * - register：按 name 注册（重名覆盖返回旧值）；
 * - get：按 name 取；未知返回 undefined；
 * - list：全部注册 Provider（按注册顺序）；
 * - defaultName：当前默认 Provider 名（config defaultProvider 优先，否则注册表第一个）。
 */

import type { Provider } from './provider';

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private defaultProviderName: string | undefined;

  /** 注册 Provider（重名覆盖）；返回是否新注册。 */
  register(provider: Provider): boolean {
    const isNew = !this.providers.has(provider.name);
    this.providers.set(provider.name, provider);
    return isNew;
  }

  /** 按名取 Provider；未知返回 undefined。 */
  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /** 全部已注册 Provider（按注册顺序）。 */
  list(): Provider[] {
    return [...this.providers.values()];
  }

  /** 已注册 Provider 名列表。 */
  names(): string[] {
    return [...this.providers.keys()];
  }

  /** 设置默认 Provider 名（config defaultProvider；未知名不生效）。 */
  setDefault(name: string | undefined): void {
    if (name === undefined || this.providers.has(name)) {
      this.defaultProviderName = name;
    }
  }

  /** 当前默认 Provider；无默认或默认不存在 → 第一个注册的 Provider。 */
  default(): Provider | undefined {
    if (this.defaultProviderName !== undefined) {
      const def = this.providers.get(this.defaultProviderName);
      if (def !== undefined) {
        return def;
      }
    }
    return this.providers.values().next().value as Provider | undefined;
  }

  /** 当前默认 Provider 名；无默认 → undefined。 */
  defaultName(): string | undefined {
    return this.default()?.name;
  }

  /** 注册表是否为空。 */
  get empty(): boolean {
    return this.providers.size === 0;
  }
}
