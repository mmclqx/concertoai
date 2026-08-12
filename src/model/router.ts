/**
 * ProviderRouter（v4.0 M3 T3.3/T3.4）：选择 / 切换 / fallback。
 *
 * - select：按名选择 Provider（未知返回 undefined）；
 * - switchTo：切换当前 Provider（返回新 Provider）；
 * - withFallback：执行 chat 时主 Provider 故障自动切备选（≤1 次，D54/ADR-034），
 *   返回 { provider, result } 标注实际使用的 Provider 与是否发生 fallback。
 *
 * 说明：fallback 仅对「首字节前失败」（连接/鉴权/5xx）生效；
 * 流开始后的错误不切换（避免重复消费已生成内容）。
 */

import type { ChatCompletionChunk, StreamChatParams } from './client';
import type { Provider, ProviderStatus } from './provider';
import type { ProviderRegistry } from './registry';

/** 执行结果：实际使用的 Provider + 流。 */
export interface RoutedChat {
  /** 实际执行 chat 的 Provider。 */
  provider: Provider;
  /** 是否发生了 fallback（主 Provider 故障切备选）。 */
  fellBack: boolean;
  /** 流式结果。 */
  stream: AsyncGenerator<ChatCompletionChunk>;
}

/** 启动 fallback 决策结果（chat 装配时一次探测）。 */
export interface StartupFallback {
  /** 实际使用的 Provider（可能已切换）。 */
  provider: Provider;
  /** 是否发生了 fallback（主 Provider 故障 → 备选）。 */
  fellBack: boolean;
  /** 故障原因（fellBack=true 时；展示给用户）。 */
  reason?: string;
}

export class ProviderRouter {
  constructor(private readonly registry: ProviderRegistry) {}

  /** 按名选择；未知返回 undefined。 */
  select(name: string | undefined): Provider | undefined {
    if (name === undefined) {
      return this.registry.default();
    }
    return this.registry.get(name);
  }

  /** 切换当前 Provider（registry.setDefault）；返回新 Provider（未知 → undefined）。 */
  switchTo(name: string): Provider | undefined {
    const provider = this.registry.get(name);
    if (provider !== undefined) {
      this.registry.setDefault(name);
    }
    return provider;
  }

  /**
   * 带 fallback 的 chat 执行（T3.4）：
   * 主 Provider 首字节前失败 → 自动切备选（默认 Provider）重试一次；
   * 备选也失败 → 抛最后一个错误。流开始后的错误不上抛给 fallback 逻辑。
   */
  async chatWithFallback(primary: Provider, params: StreamChatParams): Promise<RoutedChat> {
    const fallback = this.registry.default();
    // 主 Provider 即默认 → 无备选可切
    if (fallback === undefined || fallback.name === primary.name) {
      return { provider: primary, fellBack: false, stream: primary.streamChat(params) };
    }
    try {
      // 首 chunk 探测：成功则缓存并透传（不丢失内容），失败触发 fallback
      const probe = await probeFirstChunk(primary.streamChat(params));
      return { provider: primary, fellBack: false, stream: probe.stream };
    } catch (err) {
      // 仅网络/鉴权类错误 fallback（错误信息含 HTTP/网络/超时/鉴权关键词）
      const message = err instanceof Error ? err.message : String(err);
      if (!/HTTP|超时|timeout|网络|fetch|Unauthorized|401|403|5\d\d/i.test(message)) {
        throw err;
      }
      return {
        provider: fallback,
        fellBack: true,
        stream: fallback.streamChat(params),
      };
    }
  }

  /** 全部 Provider 状态（provider list 展示）：健康检查并行执行，单项失败降级 unavailable。 */
  async statusAll(): Promise<
    Array<{ provider: Provider; status: ProviderStatus; latencyMs: number }>
  > {
    const results = await Promise.all(
      this.registry.list().map(async (provider) => {
        const health = await provider.healthCheck();
        return {
          provider,
          status: (health.ok ? 'ok' : 'unavailable') as ProviderStatus,
          latencyMs: health.latencyMs,
        };
      }),
    );
    return results;
  }

  /**
   * 启动 fallback 决策（T3.4）：chat 装配时对主 Provider 做一次健康探测，
   * 失败 → 自动切到备选（默认 Provider）并返回 fellBack=true + reason。
   *
   * 规则：
   * - 主 Provider 即默认（无备选）→ 保持主 Provider（不探测）；
   * - 主 Provider 健康 → 保持；探测失败 → 检查备选健康，备选可用才切换；
   * - 备选也不可用 → 保持主 Provider（避免「全挂时切来切去」，让后续调用原样报错）。
   */
  async resolveStartupProvider(
    primaryName: string,
    options: { healthCheckTimeoutMs?: number } = {},
  ): Promise<StartupFallback> {
    const primary = this.registry.get(primaryName) ?? this.registry.default();
    if (primary === undefined) {
      // 空注册表：无 Provider 可用（上层会报错）
      throw new Error('No provider registered');
    }
    const fallback = this.registry.default();
    // 无备选或备选即主 → 不探测不切换
    if (fallback === undefined || fallback.name === primary.name) {
      return { provider: primary, fellBack: false };
    }
    // 主 Provider 健康探测（带超时——网络挂起时不阻塞启动太久）
    const health = await withTimeout(primary.healthCheck(), options.healthCheckTimeoutMs ?? 5_000);
    if (health.ok) {
      return { provider: primary, fellBack: false };
    }
    // 备选健康探测；可用才切换
    const fallbackHealth = await withTimeout(
      fallback.healthCheck(),
      options.healthCheckTimeoutMs ?? 5_000,
    );
    if (fallbackHealth.ok) {
      return {
        provider: fallback,
        fellBack: true,
        reason: health.error ?? 'primary unavailable',
      };
    }
    return { provider: primary, fellBack: false };
  }
}

/** 带超时的 Promise 包装：超时返回降级结果（不抛错，避免启动阻塞）。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => {
        resolve({ ok: false, latencyMs: timeoutMs, error: 'health check timed out' } as T);
      }, timeoutMs);
    }),
  ]);
}

/** 探测首个 chunk：成功则缓存并透传（不丢失内容），失败抛错（触发 fallback）。 */
async function probeFirstChunk(
  stream: AsyncGenerator<ChatCompletionChunk>,
): Promise<{ stream: AsyncGenerator<ChatCompletionChunk> }> {
  const first = await stream.next();
  async function* withFirst(): AsyncGenerator<ChatCompletionChunk> {
    // first.done 为 true（空流）时直接结束；否则先 yield 缓存的首 chunk 再透传剩余
    if (!first.done) {
      yield first.value;
    }
    yield* stream;
  }
  return { stream: withFirst() };
}
