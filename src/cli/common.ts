/**
 * CLI 命令共享的轻量工具（v2.1 性能优化）。
 *
 * run / plan 命令只依赖这里的纯函数与常量，从本模块导入即可，
 * 无需加载 chat.tsx 的完整 TUI 依赖树（ink/react/ui/mcp/skill），
 * 显著降低 `concertoai run` / `concertoai plan` 的启动成本。
 */

import os from 'node:os';
import { getDefaultModel, getModel, listModels } from '../model/models';
import { getActiveAccount, getApiKeyFor } from '../store/accounts';
import type { MCPServerEntry } from '../store/config';
import { loadConfig } from '../store/config';
import { configPath } from '../store/paths';
import { ProjectRegistry } from '../store/projects';
import { editFileTool } from '../tools/edit';
import { listDirectoryTool, readFileTool, searchContentTool } from '../tools/read';
import type { ToolSpec } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import { shellTool } from '../tools/shell';

/** 免审批直跑的安全命令白名单（用户可后续配置化）。 */
export const DEFAULT_ALLOWLIST = ['git status', 'git diff', 'npm test', 'npm run test'];

/** 构建操作系统信息提示，注入 system prompt 使模型自动适配命令。 */
export function buildOsHint(): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'win32') {
    return `## 运行环境\n操作系统: Windows ${arch}\n终端: cmd.exe / PowerShell\n\n> ⚠️ 命令适配：请使用 Windows 兼容的命令。不支持 pwd/ls/cat/grep 等 UNIX 命令。替代方案：cd/dir/type/findstr。获取当前目录请用 \`node -e "console.log(process.cwd())"\`。`;
  }
  if (platform === 'darwin') {
    return `## 运行环境\n操作系统: macOS ${arch}\n终端: zsh/bash`;
  }
  return `## 运行环境\n操作系统: Linux ${arch}\n终端: bash`;
}

export function resolveModel(modelId: string | undefined): string {
  if (modelId === undefined) {
    return getDefaultModel().id;
  }
  const profile = getModel(modelId);
  if (profile === undefined) {
    console.error(
      `未知模型: ${modelId}（可用: ${listModels()
        .map((m) => m.id)
        .join(', ')}）`,
    );
    process.exit(1);
  }
  return profile.id;
}

// ═══ v3.1 M3 T3.3：API Key 解析链（CLI > 环境变量 > active account > config.json）═══

/** Key 来源。 */
export type ApiKeySource = 'cli' | 'env' | 'account' | 'config' | 'none';

/** 解析后的 Key 与来源说明。 */
export interface ResolvedApiKey {
  /** 最终生效的 Key；无任何来源时为 undefined（调用方报错/跳过）。 */
  key: string | undefined;
  /** 来源。 */
  source: ApiKeySource;
  /** source=account 时的账号名。 */
  accountName?: string;
}

/** resolveApiKey 选项。 */
export interface ResolveApiKeyOptions {
  /** CLI 显式注入的 Key（--api-key，预留；优先级最高）。 */
  cliKey?: string;
  /** 环境变量值（测试注入；默认 process.env.DEEPSEEK_API_KEY）。 */
  envKey?: string;
  /** accounts 根目录（测试注入；默认 ~/.concertoai/accounts）。 */
  accountsRoot?: string;
  /** config.json 中的 Key（当前版本无此字段，预留）。 */
  configKey?: string;
}

/**
 * 解析 API Key：CLI > 环境变量 `DEEPSEEK_API_KEY` > active account > config.json。
 * 不抛错：无任何来源时返回 { key: undefined, source: 'none' }。
 */
export async function resolveApiKey(options: ResolveApiKeyOptions = {}): Promise<ResolvedApiKey> {
  const cliKey = options.cliKey;
  if (cliKey !== undefined && cliKey !== '') {
    return { key: cliKey, source: 'cli' };
  }
  const envKey = options.envKey !== undefined ? options.envKey : process.env.DEEPSEEK_API_KEY;
  if (envKey !== undefined && envKey !== '') {
    return { key: envKey, source: 'env' };
  }
  const active = await getActiveAccount(options.accountsRoot);
  if (active !== undefined) {
    try {
      const key = await getApiKeyFor(active, options.accountsRoot);
      return { key, source: 'account', accountName: active };
    } catch {
      // 指针指向不存在的账号 → 继续回退
    }
  }
  const configKey = options.configKey;
  if (configKey !== undefined && configKey !== '') {
    return { key: configKey, source: 'config' };
  }
  return { key: undefined, source: 'none' };
}

/**
 * 读取 config.json 中 `providers.deepseek.apiKey`（v5.0 T1）。
 *
 * 背景（真实缺口修复）：入口 `getApiKey()` 调 `resolveApiKeyCached()` 时**不传 configKey**，
 * 因此 `providers.deepseek.apiKey` 只在 provider-runtime 链路生效，在 chat/run/plan 入口不生效。
 * 缺 Key 引导的「方式 3：写入配置文件」若指向不生效的字段，就是重演 v4.1.1
 * 「装好了但跑不通」（见 docs/09-踩坑记录/2026-08-16-preflight自动初始化装好但跑不通.md）。
 *
 * 容错：配置缺失 / 损坏 / 无该字段 → 一律返回 undefined（不抛错，由调用方决定是否报缺 Key）。
 */
export async function readConfigDeepseekKey(configFile?: string): Promise<string | undefined> {
  try {
    const config = await loadConfig(configFile ?? configPath());
    const providers = (config as { providers?: Record<string, { apiKey?: string }> }).providers;
    const key = providers?.deepseek?.apiKey;
    return typeof key === 'string' && key.trim() !== '' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** 打码 API Key：`sk-****abcd`（仅显示后 4 位；短 Key 全部掩码）。 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) {
    return '****';
  }
  const last4 = trimmed.slice(-4);
  const prefix = /^sk-[A-Za-z0-9]+$/i.test(trimmed) ? 'sk-' : '';
  return `${prefix}****${last4}`;
}

// ═══ v3.2 M4 T4.5：启动期缓存（消除重复 I/O——同一进程多次解析 Key / 加载项目注册表）═══

let apiKeyCache: { accountsRoot: string; value: ResolvedApiKey } | undefined;

/** 项目注册表缓存（按 registryFile 路径键）。 */
const projectRegistryCache = new Map<string, ProjectRegistry>();

/**
 * 解析 API Key 并缓存（v3.2 M4 / T4.5）。
 * 同一进程、同一 accountsRoot 下只读一次 active-account + 账号 config；
 * 之后命中缓存返回（CLI 启动期多次命令调用消除重复 I/O）。
 *
 * S3（v3.3）：缓存**永不过期**——同一进程内切换 active 账号后再次 resolve 仍返回旧值。
 * 仅适用于 CLI 一次性进程（每次命令独立进程，进程内 resolve 次数有限，且账号切换
 * 均在进程启动前完成）；**不适用于长驻进程**（如服务器/daemon 内多次切换账号场景），
 * 长驻进程应改用 `clearApiKeyCache()` 显式失效或直接调用 `resolveApiKey()`。
 */
export async function resolveApiKeyCached(
  options: ResolveApiKeyOptions = {},
): Promise<ResolvedApiKey> {
  const accountsRoot = options.accountsRoot ?? '';
  if (apiKeyCache !== undefined && apiKeyCache.accountsRoot === accountsRoot) {
    return apiKeyCache.value;
  }
  const value = await resolveApiKey(options);
  apiKeyCache = { accountsRoot, value };
  return value;
}

/** 清空 API Key 缓存（测试注入：验证缓存失效后重新解析）。 */
export function clearApiKeyCache(): void {
  apiKeyCache = undefined;
}

/** 加载项目注册表并缓存（v3.2 M4 / T4.5）：同一 registryFile 只读一次 projects.json。 */
export async function loadProjectRegistryCached(registryFile?: string): Promise<ProjectRegistry> {
  const key = registryFile ?? '';
  const cached = projectRegistryCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const registry = await ProjectRegistry.load(registryFile);
  projectRegistryCache.set(key, registry);
  return registry;
}

/** 清空项目注册表缓存（测试注入）。 */
export function clearProjectRegistryCache(): void {
  projectRegistryCache.clear();
}

/** 项目上下文（T2.3）：按 cwd 精确匹配已注册项目。 */
export interface ResolvedProject {
  name: string;
  path: string;
  whitelist: string[] | undefined;
  mcpServers: MCPServerEntry[] | undefined;
}

/**
 * 按 cwd 精确探测已注册项目（T2.3/T2.4 隔离矩阵基础）。
 * 未匹配返回 undefined（使用默认全局配置）。注册表损坏时宽松降级为 undefined。
 * @param cwd 当前工作目录（已含 -p chdir 后的项目路径）
 * @param registryFile 注册表文件路径（测试注入；缺省 ~/.concertoai/projects.json）
 */
export async function resolveProjectForCwd(
  cwd: string,
  registryFile?: string,
): Promise<ResolvedProject | undefined> {
  // v3.2 M4 / T4.5：走模块级缓存（-p 模式 preAction 已加载时复用，消除重复读盘）
  const registry = await loadProjectRegistryCached(registryFile);
  const hit = registry.findByPath(cwd);
  if (hit === undefined) {
    return undefined;
  }
  return {
    name: hit.name,
    path: hit.entry.path,
    whitelist: hit.entry.whitelist,
    mcpServers: hit.entry.mcpServers,
  };
}

/**
 * 合并全局白名单与项目级白名单（T2.3）。
 * 去重合并：项目白名单追加到全局后面，保持全局前缀 + 项目追加的顺序。
 */
export function mergeAllowlist(
  globalAllowlist: string[] | undefined,
  projectWhitelist: string[] | undefined,
): string[] {
  const merged = [...(globalAllowlist ?? [])];
  if (projectWhitelist !== undefined) {
    for (const prefix of projectWhitelist) {
      if (!merged.includes(prefix)) {
        merged.push(prefix);
      }
    }
  }
  return merged;
}

export function buildRegistry(
  mcpTools?: ToolSpec[],
  spawnTool?: ToolSpec,
  knowledgeTools?: ToolSpec[],
): ToolRegistry {
  const registry = new ToolRegistry()
    .register(readFileTool)
    .register(listDirectoryTool)
    .register(searchContentTool)
    .register(editFileTool)
    .register(shellTool);
  if (spawnTool !== undefined) {
    registry.register(spawnTool);
  }
  if (mcpTools !== undefined) {
    for (const tool of mcpTools) {
      registry.register(tool);
    }
  }
  if (knowledgeTools !== undefined) {
    for (const tool of knowledgeTools) {
      registry.register(tool);
    }
  }
  return registry;
}
