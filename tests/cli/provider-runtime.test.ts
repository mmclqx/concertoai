/**
 * 三动词的 provider 运行时（v5.0 K14）测试。
 *
 * ## 这条线为什么必须有用例
 *
 * 事故形态是「**静默换端点**」：`review` / `commit` / `fix` 原先各自
 * `new DeepSeekClient({ apiKey })`——不传 `baseUrl`。于是配了
 * `config.providers.deepseek.baseUrl`（企业代理 / 自建中转 / Ollama 兼容网关）的用户：
 * `chat` 走自定义端点、三个动词静默打 `api.deepseek.com` —— 要么 401，
 * 要么**按官方价真花钱**；更糟的是 K15 刚加的成本回执会据此报出「不是这笔账」的金额。
 *
 * 所以这里的断言一律落在「**请求真的打到哪个 URL**」这种硬事实上，
 * 不靠日志措辞（措辞可以改，URL 不会骗人）。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isOfficialDeepSeekEndpoint,
  needsVerbApiKey,
  OFFICIAL_DEEPSEEK_HOST,
  resolveVerbClient,
  resolveVerbRuntime,
} from '../../src/cli/provider-runtime';
import { en } from '../../src/i18n/en';
import { zh } from '../../src/i18n/zh';
import type { ConcertoAIConfig } from '../../src/store/config';
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from '../../src/store/config';

// ── 夹具 ──────────────────────────────────────────────────────

/** 造一份 v4 形态配置（只写与本组用例相关的字段）。 */
function configOf(patch: Record<string, unknown>): ConcertoAIConfig {
  return { schemaVersion: 2, ...patch } as unknown as ConcertoAIConfig;
}

/** 隔离的 accounts 目录（防止读到开发机真实账号）。 */
let accountsRoot: string;

beforeEach(async () => {
  accountsRoot = await mkdtemp(path.join(os.tmpdir(), 'k14-accounts-'));
  // 环境变量必须钉死：开发机上真 Key 会让「Key 从哪来」的断言随机器漂移
  vi.stubEnv('DEEPSEEK_API_KEY', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(accountsRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 假 fetch：记录 URL，返回 401（不联网、不花钱）。 */
function recordingFetch(urls: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('{"error":{"message":"probe"}}', { status: 401 });
  }) as typeof fetch;
}

// ── 端点判定 ──────────────────────────────────────────────────

/**
 * 文案护栏：网络不可达时的「下一步」曾经写死 `api.deepseek.com`。
 *
 * 端点可配置之后，那句话会把自定义端点用户引到**错误的地址**——
 * 这正是 K14 的同一个病（把「我们默认的端点」当成「你的端点」）。
 * 断言它只说「你配置的端点」，默认域名只允许作为括注出现。
 */
describe('网络不可达的文案不再点名官方域名（K14 的同一病）', () => {
  it('zh / en 都必须说「你配置的端点」，默认域名只能是括注', () => {
    for (const text of [zh.reviewer.actionNetwork, en.reviewer.actionNetwork]) {
      expect(text).toMatch(/配置的端点|configured endpoint/);
      // 官方域名仍可出现在括号里作为默认值说明，但不许作为唯一指向
      const withoutParen = text.replace(/（[^）]*）|\([^)]*\)/g, '');
      expect(withoutParen).not.toContain(OFFICIAL_DEEPSEEK_HOST);
    }
  });
});

describe('isOfficialDeepSeekEndpoint（成本回执要不要说「非账单」的判据）', () => {
  it('空 / 未配置 → 官方（等价于 client 默认端点）', () => {
    expect(isOfficialDeepSeekEndpoint(undefined)).toBe(true);
    expect(isOfficialDeepSeekEndpoint('')).toBe(true);
    expect(isOfficialDeepSeekEndpoint('   ')).toBe(true);
  });

  it('官方域名（含大小写 / 带路径 / https）→ true', () => {
    expect(isOfficialDeepSeekEndpoint(`https://${OFFICIAL_DEEPSEEK_HOST}`)).toBe(true);
    expect(isOfficialDeepSeekEndpoint(`https://${OFFICIAL_DEEPSEEK_HOST}/v1`)).toBe(true);
    expect(isOfficialDeepSeekEndpoint(`HTTPS://API.DEEPSEEK.COM/v1`)).toBe(true);
  });

  it('自定义端点 / 无法解析 → false（按「金额只是估算」处理，方向安全）', () => {
    expect(isOfficialDeepSeekEndpoint('http://127.0.0.1:9/v1')).toBe(false);
    expect(isOfficialDeepSeekEndpoint('https://gateway.corp.internal/v1')).toBe(false);
    expect(isOfficialDeepSeekEndpoint('http://localhost:11434/v1')).toBe(false);
    // 打错字的配置不能因为「解析失败」就被当成官方端点
    expect(isOfficialDeepSeekEndpoint('api.deepseek.com')).toBe(false);
  });
});

// ── 运行时解析 ────────────────────────────────────────────────

describe('resolveVerbRuntime（三动词共用的唯一解析入口）', () => {
  it('★ 探针通电：config 里的 baseUrl 真被读到（不是「我记得注入了」）', async () => {
    const config = configOf({
      providers: { deepseek: { apiKey: 'sk-cfg', baseUrl: 'http://127.0.0.1:9/v1' } },
    });
    const runtime = await resolveVerbRuntime({ config, accountsRoot });
    expect(runtime.baseUrl).toBe('http://127.0.0.1:9/v1');
    expect(runtime.officialEndpoint).toBe(false);
    expect(runtime.provider).toBe('deepseek');
  });

  it('未配 baseUrl → baseUrl 为 undefined（走 client 默认官方端点）+ officialEndpoint=true', async () => {
    const config = configOf({ providers: { deepseek: { apiKey: 'sk-cfg' } } });
    const runtime = await resolveVerbRuntime({ config, accountsRoot });
    expect(runtime.baseUrl).toBeUndefined();
    expect(runtime.officialEndpoint).toBe(true);
  });

  it('默认档模型 = 模型表默认（deepseek 才做模型表校验）', async () => {
    const runtime = await resolveVerbRuntime({ config: configOf({}), accountsRoot });
    expect(runtime.model).toBe('deepseek-v4-flash');
  });

  it('`-m auto` 走既有 auto 预设（不在这里另写一套展开逻辑）', async () => {
    const runtime = await resolveVerbRuntime({ config: configOf({}), accountsRoot, model: 'auto' });
    expect(runtime.model).toBe('deepseek-v4-flash');
  });

  it('defaultProvider=ollama → 本地端点 + ollama 默认模型（不被「未知模型」挡死）', async () => {
    const config = configOf({ defaultProvider: 'ollama' });
    const runtime = await resolveVerbRuntime({ config, accountsRoot });
    expect(runtime.provider).toBe('ollama');
    expect(runtime.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(runtime.model).toBe(DEFAULT_OLLAMA_MODEL);
    expect(runtime.officialEndpoint).toBe(false);
  });

  it('defaultProvider=openai → 官方 openai 端点 + 它自己的默认模型', async () => {
    const config = configOf({ defaultProvider: 'openai', providers: { openai: { apiKey: 'k' } } });
    const runtime = await resolveVerbRuntime({ config, accountsRoot });
    expect(runtime.baseUrl).toBe('https://api.openai.com/v1');
    expect(runtime.model).toBe('gpt-4o-mini');
    expect(runtime.apiKey).toBe('k');
  });

  /**
   * 安全边界：非 DeepSeek provider **只认自己的 Key**。
   *
   * 把 DeepSeek 的环境变量 / 账号 Key 发给第三方端点，比「没 Key 报错」更糟——
   * 用户会把自己付费的 Key 泄漏给一个他没审过的服务。
   */
  it('★ 自定义 provider 不吃 DeepSeek 的 Key（不把别人的 Key 发给第三方端点）', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-must-not-leak');
    const config = configOf({
      defaultProvider: 'gateway',
      providers: {
        deepseek: { apiKey: 'sk-deepseek-own' },
        gateway: { baseUrl: 'http://127.0.0.1:9/v1' },
      },
    });
    const runtime = await resolveVerbRuntime({ config, accountsRoot });
    expect(runtime.provider).toBe('gateway');
    expect(runtime.baseUrl).toBe('http://127.0.0.1:9/v1');
    expect(runtime.apiKey).toBe('');
    expect(runtime.apiKey).not.toBe('sk-must-not-leak');
  });
});

// ── 入口「要不要拦下来教用户配 Key」 ────────────────────────────

/**
 * `needsVerbApiKey` 决定入口是否调 `getApiKey()`（那个函数会打印 **DeepSeek** 的
 * 三种配置方式后 `exit 1`）。
 *
 * 判据如果写成「非 ollama 且没 Key」，就会出两个错：
 * - `openai` / 自定义网关用户缺 Key 时被塞一份 **DeepSeek** 的引导 → 指向别人家的配置项
 *   （K14 同一种病：把「我们默认的」当成「你配的」）；
 * - 而 `ollama` 用户则被「先要 Key」挡在门外，端点配对了也用不上（K14 只修一半）。
 */
describe('needsVerbApiKey（入口缺 Key 引导的适用面）', () => {
  const base = {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseUrl: undefined,
    apiKey: '',
    officialEndpoint: true,
  } satisfies Parameters<typeof needsVerbApiKey>[0];

  it('deepseek 缺 Key → true（走既有中文引导）', () => {
    expect(needsVerbApiKey(base)).toBe(true);
  });

  it('deepseek 有 Key（含 config 里的 Key）→ false', () => {
    expect(needsVerbApiKey({ ...base, apiKey: 'sk-cfg' })).toBe(false);
  });

  it('ollama 无 Key → false（本地模型不需要 Key，不能被挡在门外）', () => {
    expect(
      needsVerbApiKey({
        ...base,
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        officialEndpoint: false,
      }),
    ).toBe(false);
  });

  it('openai / 自定义网关缺 Key → false（不拿 DeepSeek 引导冒充通用引导）', () => {
    for (const provider of ['openai', 'gateway']) {
      expect(needsVerbApiKey({ ...base, provider, officialEndpoint: false })).toBe(false);
    }
  });
});

// ── 取客户端 ──────────────────────────────────────────────────

describe('resolveVerbClient（三动词取客户端的唯一入口）', () => {
  it('★ 硬证据：请求真的打到 config 里的 baseUrl，而不是官方域名', async () => {
    const urls: string[] = [];
    const runtime = await resolveVerbRuntime({
      config: configOf({
        providers: { deepseek: { apiKey: 'sk-cfg', baseUrl: 'http://127.0.0.1:9/v1' } },
      }),
      accountsRoot,
    });
    const resolved = await resolveVerbClient({ runtime, fetchImpl: recordingFetch(urls) });
    expect(resolved.client).toBeDefined();
    expect(resolved.officialEndpoint).toBe(false);
    // 消费一次流（401 → 抛错），只为拿到「发了哪个 URL」
    await expect(async () => {
      for await (const _chunk of resolved.client?.streamChat({
        model: resolved.model,
        messages: [{ role: 'user', content: 'hi' }],
      }) ?? []) {
        // 不关心内容
      }
    }).rejects.toBeDefined();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('http://127.0.0.1:9/v1/chat/completions');
    expect(urls[0]).not.toContain(OFFICIAL_DEEPSEEK_HOST);
  });

  it('只给 apiKey（无任何配置信号）→ 不读盘、按官方端点（行为与 K14 之前一致）', async () => {
    const resolved = await resolveVerbClient({
      apiKey: 'sk-only',
      // 指向一个不存在的路径：真去读了就会拿到空配置，反而暴露「读了盘」
      configPath: path.join(accountsRoot, 'no-such-config.json'),
    });
    expect(resolved.client).toBeDefined();
    expect(resolved.officialEndpoint).toBe(true);
    expect(resolved.provider).toBe('deepseek');
  });

  it('没有 Key 也没有配置 → client 为 undefined（不伪造一个「能用的客户端」）', async () => {
    const resolved = await resolveVerbClient({ config: configOf({}), accountsRoot });
    expect(resolved.client).toBeUndefined();
    // 模型仍然有值：报告/日志要用它说明「本来打算用哪个模型」
    expect(resolved.model).toBe('deepseek-v4-flash');
  });

  it('ollama 本地无 Key 也照样构建客户端（本地模型不需要 Key）', async () => {
    const runtime = await resolveVerbRuntime({
      config: configOf({ defaultProvider: 'ollama' }),
      accountsRoot,
    });
    const resolved = await resolveVerbClient({ runtime });
    expect(resolved.client).toBeDefined();
    expect(resolved.model).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it('注入 client（测试/嵌入式）→ 原样返回，端点按官方处理（未知即不制造噪音）', async () => {
    const injected = {
      // biome-ignore lint/correctness/useYield: 假实现，故意不产出
      async *streamChat() {
        return;
      },
    };
    const resolved = await resolveVerbClient({ client: injected, model: 'deepseek-v4-pro' });
    expect(resolved.client).toBe(injected);
    expect(resolved.model).toBe('deepseek-v4-pro');
    expect(resolved.officialEndpoint).toBe(true);
    expect(resolved.provider).toBe('injected');
  });
});
