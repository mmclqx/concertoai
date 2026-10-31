/**
 * Provider 运行时解析（v4.0 M3 T3.1）：把 `--provider` / config defaultProvider
 * 解析为实际 client 构建参数（model / baseUrl / apiKey），供 chat / run / plan 共用。
 *
 * 三 Provider 均为 OpenAI 兼容 /chat/completions 协议，复用 DeepSeekClient
 * （baseUrl 可配）即可切换，无需为每个 Provider 单独建客户端。
 *
 * 端点默认值：
 * - deepseek：https://api.deepseek.com（client.ts 默认，baseUrl 传 undefined）；
 * - openai：https://api.openai.com/v1（或 config providers.openai.baseUrl）；
 * - ollama：http://localhost:11434/v1（本地）。
 *
 * Key 解析链（§3.5）：CLI > 环境变量 > active account > config；
 * - deepseek：保留现有 resolveApiKey 链（CLI -m 兼容）；-m 仍映射 defaultProvider.model；
 * - openai：config providers.openai.apiKey > accounts/openai 的 Key；
 * - ollama：本地无 Key。
 */

import { DeepSeekClient, type ModelClient } from '../model/client';
import { getDefaultModel } from '../model/models';
import { getApiKeyFor } from '../store/accounts';
import {
  type ConcertoAIConfig,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  loadConfig,
} from '../store/config';
import { resolveApiKey, resolveModel } from './common';

/** OpenAI 默认端点（/v1，DeepSeekClient 会在其后拼 /chat/completions）。 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** OpenAI 默认模型（config 未配置时）。 */
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

/** 解析后的运行时 Provider 信息（client 构建参数）。 */
export interface RuntimeProviderInfo {
  /** Provider 名（deepseek / openai / ollama / 自定义）。 */
  provider: string;
  /** 实际模型 ID（CLI -m > provider 配置 > 按 Provider 默认）。 */
  model: string;
  /** API baseUrl（undefined = 用 DeepSeekClient 默认端点）。 */
  baseUrl: string | undefined;
  /** API Key（ollama 本地为空字符串）。 */
  apiKey: string;
}

/**
 * 解析运行时 Provider（T3.1 核心）：
 * 优先级 provider 名：CLI --provider > config defaultProvider > 'deepseek'；
 * model 优先级：CLI -m > providers[provider].model > 按 Provider 默认。
 */
export async function resolveRuntimeProvider(
  config: ConcertoAIConfig,
  options: {
    /** CLI --provider（临时切换，本次进程生效）。 */
    provider?: string;
    /** CLI -m（映射到 defaultProvider.model，保持兼容）。 */
    model?: string;
    /** CLI 注入的 DeepSeek Key（chat/run 现有参数；仅 deepseek 生效）。 */
    apiKey?: string;
    /** accounts 根目录（测试注入）。 */
    accountsRoot?: string;
  } = {},
): Promise<RuntimeProviderInfo> {
  const fileV4 = config as ConcertoAIConfig & {
    defaultProvider?: string;
    providers?: Record<
      string,
      { type?: string; model?: string; baseUrl?: string; apiKey?: string }
    >;
  };
  const provider = options.provider ?? fileV4.defaultProvider ?? 'deepseek';
  const providers = fileV4.providers ?? {};
  const cfg = providers[provider] ?? {};

  // model：CLI -m > provider 配置 > 按 Provider 默认
  let model = options.model;
  if (model === undefined) {
    model = cfg.model;
  }
  if (model === undefined) {
    if (provider === 'openai') {
      model = OPENAI_DEFAULT_MODEL;
    } else if (provider === 'ollama') {
      model = DEFAULT_OLLAMA_MODEL;
    } else {
      model = getDefaultModel().id;
    }
  }

  // baseUrl：config 显式 > Provider 默认（deepseek 默认 undefined = client 默认端点）
  let baseUrl = cfg.baseUrl;
  if (baseUrl === undefined || baseUrl === '') {
    baseUrl =
      provider === 'openai'
        ? OPENAI_BASE_URL
        : provider === 'ollama'
          ? DEFAULT_OLLAMA_BASE_URL
          : undefined;
  }

  // apiKey：deepseek 走现有链（CLI > env > active account > config）；
  // openai 走 config providers.openai.apiKey > accounts/openai；ollama 本地空。
  let apiKey = '';
  if (provider === 'deepseek') {
    const resolved = await resolveApiKey({
      accountsRoot: options.accountsRoot,
      configKey: cfg.apiKey,
    });
    apiKey = options.apiKey ?? resolved.key ?? '';
  } else if (provider === 'openai') {
    apiKey = cfg.apiKey ?? '';
    if (apiKey === '') {
      try {
        apiKey = await getApiKeyFor('openai', options.accountsRoot);
      } catch {
        apiKey = '';
      }
    }
  } else if (typeof cfg.apiKey === 'string') {
    // 自定义端点（企业代理 / 自建中转）与 ollama：Key 只可能来自 provider 自己的配置项。
    // 不读 DeepSeek 的环境变量/账号链——把别人的 Key 发给自定义端点比「没 Key」更糟。
    apiKey = cfg.apiKey;
  }

  return { provider, model, baseUrl, apiKey };
}

/** 按运行时信息构建 OpenAI 兼容客户端（三 Provider 统一复用 DeepSeekClient）。 */
export function buildClientForProvider(
  info: RuntimeProviderInfo,
  fetchImpl?: typeof fetch,
): DeepSeekClient {
  return new DeepSeekClient({ apiKey: info.apiKey, baseUrl: info.baseUrl, fetchImpl });
}

// ═══ v5.0 K14：三个花钱动词（review / commit / fix）的运行时解析 ═══════════
//
// ## 为什么必须走这里
//
// 这三个动词原先各自 `new DeepSeekClient({ apiKey })`——**不传 baseUrl**。于是配了
// `providers.deepseek.baseUrl`（企业代理 / 自建中转 / Ollama 兼容网关）的用户：
// `chat` 走自定义端点、`review` 静默打官方端点，要么 401，要么按官方价真花钱；
// 更糟的是 K15 的成本回执会据此按 DeepSeek 价报钱，**回执本身变成假话**。
//
// ## 三条纪律
//
// 1. **只解析一处**：动词不解析 baseUrl / provider / 模型的默认值，全在这里
//    （同一事实两处各解析一次是本项目反复踩的坑，见 09-踩坑记录/2026-10-29）；
// 2. **DeepSeek 才做模型表校验**：`resolveModel()` 会拿 `MODEL_PROFILES` 校验并在
//    未知模型时 `process.exit(1)`；`gpt-4o-mini` / `llama3` 不在那张表里，
//    跳过校验才是对的（否则非 DeepSeek 用户被「未知模型」挡死）；
// 3. **不猜 Key**：非 DeepSeek provider 只认它自己的 `providers.<p>.apiKey`，
//    绝不把 DeepSeek 的环境变量/账号 Key 发给第三方端点。

/** 官方 DeepSeek 端点主机名。 */
export const OFFICIAL_DEEPSEEK_HOST = 'api.deepseek.com';

/**
 * 端点是不是「官方 DeepSeek」（决定成本回执要不要标注「按公开价估算」）。
 *
 * 判据偏保守：空 / 无法解析 → 按**自定义端点**处理（金额只是估算，标注出来比不标更诚实）。
 */
export function isOfficialDeepSeekEndpoint(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim() ?? '';
  if (trimmed === '') {
    return true;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase() === OFFICIAL_DEEPSEEK_HOST;
  } catch {
    return false;
  }
}

/** 三动词解析运行时的入参（全部可注入：测试不读真实配置）。 */
export interface VerbRuntimeOptions {
  /** CLI `-m`（显式模型；缺省按 provider 配置 / 默认档）。 */
  model?: string;
  /** CLI 注入的 Key（`deepseek` 优先于配置链，与 chat/run 同口径）。 */
  apiKey?: string;
  /** CLI `--provider`（临时切换，仅本次进程）。 */
  provider?: string;
  /** 测试注入：已加载的配置（传了就不读盘）。 */
  config?: ConcertoAIConfig;
  /** 测试注入：配置文件路径（缺省 `~/.concertoai/config.json`）。 */
  configPath?: string;
  /** 测试注入：accounts 根目录。 */
  accountsRoot?: string;
}

/** 解析结果：运行时信息 + 端点是否为官方。 */
export interface VerbRuntimeInfo extends RuntimeProviderInfo {
  /** false = 自定义端点（成本回执必须标注「按公开价估算，非账单」）。 */
  officialEndpoint: boolean;
}

/**
 * 解析三动词的运行时（provider / 模型 / baseUrl / Key）。
 *
 * **唯一会读配置文件的入口**（`loadConfig` 会顺带装载计价节假日表与配置校验提示，
 * 所以它只该在「真的要发请求」的路径上被调用一次）。
 */
export async function resolveVerbRuntime(
  options: VerbRuntimeOptions = {},
): Promise<VerbRuntimeInfo> {
  const config = options.config ?? (await loadConfig(options.configPath));
  const resolved = await resolveRuntimeProvider(config, {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.accountsRoot !== undefined ? { accountsRoot: options.accountsRoot } : {}),
  });
  // DeepSeek 走模型表校验（`auto` 展开 + 未知模型立刻报错退出）；其他 provider 原样用
  const model = resolved.provider === 'deepseek' ? resolveModel(resolved.model) : resolved.model;
  return { ...resolved, model, officialEndpoint: isOfficialDeepSeekEndpoint(resolved.baseUrl) };
}

/**
 * 运行时是否该走**入口的「缺 Key」引导**（`getApiKey()` → 打印三种配置方式 → `exit 1`）。
 *
 * 为什么单独抽一行：入口原先一律先 `getApiKey()`，于是
 * ① `defaultProvider=ollama`（本地模型、根本不需要 Key）的用户**还没解析端点就被挡死**——
 *    端点能配了，但配了的人用不上，等于没修；
 * ② `openai` / 自定义网关用户缺 Key 时，看到的是**DeepSeek 的**引导
 *    （`DEEPSEEK_API_KEY` / `provider auth deepseek`）——那是把他们指向别人的配置项，
 *    与 K14 同一种病（把「我们默认的」当成「你配的」）。
 *
 * 所以判据收窄到「**只给 deepseek 走这条路**」：其他 provider 缺 Key 时，
 * 命令自己如实降级（review 提示缺 Key、commit 走本地兜底、fix 只跑 lint:fix），
 * 绝不拿 DeepSeek 的引导冒充通用引导。
 *
 * 与 `buildVerbClient` 的分工：那个函数回答「能不能发请求」（非 ollama + 空 Key → 不发），
 * 这个函数回答「要不要在入口拦下来教用户配 Key」。两者不同，别合并。
 */
export function needsVerbApiKey(info: VerbRuntimeInfo): boolean {
  return info.provider === 'deepseek' && info.apiKey === '';
}

/**
 * 按运行时信息构建动词客户端。
 *
 * `undefined` = **不该发请求**（缺 Key）：调用方按各自口径降级（review 提示配 Key、
 * commit 走本地兜底 message、fix 只跑 lint:fix）。`ollama` 本地无 Key，照常构建。
 */
export function buildVerbClient(
  info: VerbRuntimeInfo,
  fetchImpl?: typeof fetch,
): DeepSeekClient | undefined {
  if (info.provider !== 'ollama' && info.apiKey === '') {
    return undefined;
  }
  return new DeepSeekClient({
    apiKey: info.apiKey,
    baseUrl: info.baseUrl,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}

/** 三动词取客户端的入参（`client` / `runtime` 二选一或都不给）。 */
export interface VerbClientOptions extends VerbRuntimeOptions {
  /** 测试注入的客户端（有它就不解析运行时，模型按老口径 `resolveModel` 解析）。 */
  client?: ModelClient;
  /** 已解析好的运行时（CLI 入口传，避免同一命令解析两次）。 */
  runtime?: VerbRuntimeInfo;
  /** 测试注入的 fetch（断言「请求真的打到了 baseUrl」，不联网）。 */
  fetchImpl?: typeof fetch;
}

/** 三动词取客户端的结果。 */
export interface VerbClientResolution {
  /** undefined = 没有可用端点/Key（调用方自行降级）。 */
  client: ModelClient | undefined;
  /** 生效模型 ID（`client` 为 undefined 时也要有值，供报告/日志说明）。 */
  model: string;
  /** false = 自定义端点（成本回执要标注「按公开价估算」）。 */
  officialEndpoint: boolean;
  /** 生效 provider 名（`injected` = 测试注入的客户端，端点未知）。 */
  provider: string;
}

/**
 * 三动词「取客户端」的唯一入口（K14）。
 *
 * 何时读配置（这是最容易被误改的一条）：
 * - 给了 `runtime` → 用它（CLI 入口就是这么传的，一个命令只解析一次）；
 * - 给了 `config` / `configPath` / `provider` → 现场解析；
 * - **只给了 `apiKey` → 不读配置**（按官方端点处理）。程序内调用与单测走这条，
 *   避免「跑个单测顺手读了开发机的 `~/.concertoai/config.json`」——读别人的配置
 *   会让用例行为随机器漂移（见 09-踩坑记录/2026-10-28-测试污染真实全局…）。
 *   需要配置里的 `baseUrl` 请显式传 `runtime` / `config`。
 */
export async function resolveVerbClient(
  options: VerbClientOptions = {},
): Promise<VerbClientResolution> {
  if (options.client !== undefined) {
    return {
      client: options.client,
      model: options.model ?? resolveModel(undefined),
      officialEndpoint: true,
      provider: 'injected',
    };
  }
  const shouldConsultConfig =
    options.runtime !== undefined ||
    options.config !== undefined ||
    options.configPath !== undefined ||
    options.provider !== undefined;
  if (!shouldConsultConfig) {
    // 只有 Key 没有任何配置信号：按**官方端点**构建（等价于 K14 之前的行为）。
    // 注意这里不读盘，所以「配了 baseUrl」只有通过 runtime 才会生效——见上方注释。
    const apiKey = options.apiKey ?? '';
    return {
      client:
        apiKey === ''
          ? undefined
          : new DeepSeekClient({
              apiKey,
              ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
            }),
      model: options.model ?? resolveModel(undefined),
      officialEndpoint: true,
      provider: 'deepseek',
    };
  }
  const runtime = options.runtime ?? (await resolveVerbRuntime(options));
  return {
    client: buildVerbClient(runtime, options.fetchImpl),
    model: runtime.model,
    officialEndpoint: runtime.officialEndpoint,
    provider: runtime.provider,
  };
}
