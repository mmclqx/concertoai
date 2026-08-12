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

import { DeepSeekClient } from '../model/client';
import { getDefaultModel } from '../model/models';
import { getApiKeyFor } from '../store/accounts';
import {
  type ConcertoAIConfig,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
} from '../store/config';
import { resolveApiKey } from './common';

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
