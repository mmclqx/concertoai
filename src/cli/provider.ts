/**
 * Provider CLI 命令（v4.0 M3 T3.1 / T3.2b / T3.4）。
 *
 * - concertoai provider list：列出全部可用 Provider 及状态（🟢 可用 / 🔴 不可用 / 🟡 降级）+ 成本对比；
 * - concertoai provider auth <name> [--key] [--verify]：认证 Key（交互输入不回显 → healthCheck 验证 →
 *   保存至 accounts/<name>/config.json 0600 + active 指针）；--verify 仅验证不保存；
 * - concertoai provider switch <name>：持久化切换（写 config defaultProvider）。
 *
 * Key 安全：不落日志、不进入会话记录、不进入审计（复用 accounts/ 存储体系）。
 */

import { fmt, t } from '../i18n';
import type { Provider } from '../model/provider';
import { createDeepSeekProvider } from '../model/providers/deepseek';
import { createOllamaProvider } from '../model/providers/ollama';
import { createOpenAIProvider } from '../model/providers/openai';
import { ProviderRegistry } from '../model/registry';
import { ProviderRouter } from '../model/router';
import { getActiveAccount, getApiKeyFor, saveAccount, setActiveAccount } from '../store/accounts';
import { loadConfig, writeConfig } from '../store/config';
import { configPath } from '../store/paths';
import { resolveApiKey } from './common';
import { promptLine } from './prompt';

/** 从配置 + Key 解析链构建内置 Provider 注册表（deepseek/openai/ollama）。 */
export async function buildBuiltinRegistry(
  options: { configPath?: string; accountsRoot?: string; fetchImpl?: typeof fetch } = {},
): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry();
  const config = await loadConfig(options.configPath ?? configPath());
  const fileV4 = config as typeof config & {
    defaultProvider?: string;
    providers?: Record<
      string,
      { type?: string; model?: string; baseUrl?: string; apiKey?: string }
    >;
  };
  const providers = fileV4.providers ?? {};
  const resolved = await resolveApiKey({ accountsRoot: options.accountsRoot });

  // DeepSeek（默认）：config 显式 apiKey > 解析链 Key（env/account/config）> active account
  const deepseekCfg = providers.deepseek;
  let dsKey: string | undefined = deepseekCfg?.apiKey ?? resolved.key;
  if (dsKey === undefined || dsKey === '') {
    const active = await getActiveAccount(options.accountsRoot);
    if (active !== undefined) {
      dsKey = await getApiKeyFor(active, options.accountsRoot).catch(() => undefined);
    }
  }
  if (typeof dsKey === 'string' && dsKey !== '') {
    registry.register(
      createDeepSeekProvider({
        apiKey: dsKey,
        defaultModel: deepseekCfg?.model,
        baseUrl: deepseekCfg?.baseUrl,
        fetchImpl: options.fetchImpl,
      }),
    );
  } else {
    // 无 Key 也注册（状态显示 🔴 不可用，healthCheck 会失败）
    registry.register(
      createDeepSeekProvider({
        apiKey: '',
        defaultModel: deepseekCfg?.model,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  // OpenAI（仅配置了 baseUrl 或 Key 时注册；Ollama 配置了 ollama 时注册）
  const openaiCfg = providers.openai;
  const openaiKey =
    openaiCfg?.apiKey ??
    (resolved.key !== undefined && resolved.source !== 'none' ? resolved.key : undefined);
  if (openaiCfg !== undefined || (openaiKey !== undefined && openaiKey !== '')) {
    registry.register(
      createOpenAIProvider({
        apiKey: openaiKey ?? '',
        baseUrl: openaiCfg?.baseUrl,
        defaultModel: openaiCfg?.model,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  // Ollama（本地，无 Key）：始终注册（本地服务探测；未安装时状态 🔴 不可用）
  const ollamaCfg = providers.ollama;
  registry.register(
    createOllamaProvider({
      baseUrl: ollamaCfg?.baseUrl,
      defaultModel: ollamaCfg?.model,
      fetchImpl: options.fetchImpl,
    }),
  );

  registry.setDefault(fileV4.defaultProvider);
  return registry;
}

/** provider list 输出。 */
export async function runProviderList(
  options: { configPath?: string; accountsRoot?: string; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const dict = t().provider;
  const registry = await buildBuiltinRegistry(options);
  const router = new ProviderRouter(registry);
  const defaultName = registry.defaultName();
  const statuses = await router.statusAll();
  console.log(dict.listTitle);
  for (const { provider, status, latencyMs } of statuses) {
    const icon = status === 'ok' ? '🟢' : status === 'degraded' ? '🟡' : '🔴';
    const statusLabel =
      status === 'ok'
        ? dict.statusOk
        : status === 'degraded'
          ? dict.statusDegraded
          : dict.statusUnavailable;
    const def = provider.name === defaultName ? `（${dict.defaultLabel}）` : '';
    console.log(`  ${icon} ${provider.name}${def} — ${statusLabel}（${latencyMs}ms）`);
    if (provider.type === 'ollama') {
      console.log(`    ${dict.ollamaLocalHint}`);
    }
  }
  console.log('');
  console.log(dict.switchHint);
  return 0;
}

/** provider auth：交互输入 Key（不回显）→ healthCheck 验证 → 保存。 */
export async function runProviderAuth(options: {
  name: string;
  key?: string;
  verify?: boolean;
  accountsRoot?: string;
  fetchImpl?: typeof fetch;
  input?: NodeJS.ReadableStream;
}): Promise<number> {
  const dict = t().provider;
  const name = options.name;
  // 仅支持内置 Provider 名（deepseek / openai）
  if (name !== 'deepseek' && name !== 'openai') {
    console.error(fmt(dict.authUnknown, { name }));
    return 1;
  }
  let apiKey = options.key;
  if (apiKey === undefined || apiKey === '') {
    if (process.stdin.isTTY !== true) {
      console.error(dict.authNoTty);
      return 1;
    }
    // 不回显输入（Node readline 无直接静默 API；用隐藏输入提示，回车后读入）
    const answer = await promptLine(`${fmt(dict.authPrompt, { name })} `);
    if (answer === undefined) {
      // Ctrl+C（AbortError → undefined）：用户主动取消，非崩溃（v4.0.1 修复）
      console.error(dict.authCanceled);
      return 1;
    }
    apiKey = answer;
  }
  if (apiKey === undefined || apiKey === '') {
    console.error(dict.authEmpty);
    return 1;
  }

  // healthCheck 验证
  const provider: Provider =
    name === 'openai'
      ? createOpenAIProvider({ apiKey, fetchImpl: options.fetchImpl })
      : createDeepSeekProvider({ apiKey, fetchImpl: options.fetchImpl });
  const health = await provider.healthCheck();
  if (!health.ok) {
    console.error(`${dict.authFailed} ${health.error ?? ''}`);
    return 1;
  }
  console.log(`${dict.authOk}（${health.latencyMs}ms）`);

  // --verify 仅验证不保存
  if (options.verify === true) {
    console.log(dict.authVerifyOnly);
    return 0;
  }

  // 保存至 accounts/<name>/config.json（0600）+ active 指针
  try {
    await saveAccount(name, apiKey, { accountsRoot: options.accountsRoot });
    await setActiveAccount(name, options.accountsRoot);
    console.log(fmt(dict.authSaved, { name }));
    return 0;
  } catch (err) {
    console.error(`${dict.authSaveFailed} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** provider switch：持久化切换（写 config defaultProvider）。 */
export async function runProviderSwitch(options: {
  name: string;
  configPath?: string;
}): Promise<number> {
  const dict = t().provider;
  const name = options.name;
  const cfgPath = options.configPath ?? configPath();
  const config = await loadConfig(cfgPath);
  const fileV4 = config as typeof config & {
    defaultProvider?: string;
    providers?: Record<string, unknown>;
  };
  if (fileV4.providers?.[name] === undefined) {
    console.error(fmt(dict.switchUnknown, { name }));
    return 1;
  }
  fileV4.defaultProvider = name;
  await writeConfig(fileV4, cfgPath);
  console.log(fmt(dict.switchDone, { name }));
  return 0;
}
