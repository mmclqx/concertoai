/**
 * 配置文件：~/.concertoai/config.json（带 schema 版本字段）。
 *
 * 支持字段：defaultModel（默认模型）、allowlist（命令白名单）、
 * approvalPolicy（ask / allowlist-only）、sessionDir（会话目录）、locale、
 * peakTimeStrategy（高峰时段模型切换策略）、ollamaModel / ollamaBaseUrl
 * （本地模型接入，v2.2 智能成本控制）。
 *
 * 优先级：CLI 参数 > 环境变量（LUMEN_*）> 配置文件 > 默认值。
 * 文件不存在 / JSON 损坏 / schema 版本不匹配 → 返回空配置（不抛错）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { configPath } from './paths';
import { DEFAULT_SESSION_DIR } from './session';

/** 当前配置 schema 版本。 */
export const CONFIG_SCHEMA_VERSION = 1;
/** 默认配置路径：~/.concertoai/config.json。 */
export const DEFAULT_CONFIG_PATH = configPath();

export type ApprovalPolicy = 'ask' | 'allowlist-only';

/**
 * 高峰时段模型切换策略（v2.2 智能成本控制）：
 * - `ask`：高峰时段提示用户确认是否切换到本地模型（默认）；
 * - `switch`：高峰时段直接切换到本地模型；
 * - `ignore`：忽略切换，始终使用主模型。
 */
export type PeakTimeStrategy = 'ask' | 'switch' | 'ignore';

/** 高峰时段切换策略默认值：ask（询问用户）。 */
export const DEFAULT_PEAK_TIME_STRATEGY: PeakTimeStrategy = 'ask';
/** 本地模型默认 ID（Ollama，v2.2 智能成本控制）。 */
export const DEFAULT_OLLAMA_MODEL = 'qwen3.6:27b-q4_K_M';
/** 本地模型默认 OpenAI 兼容端点（Ollama /v1）。 */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/** MCP 服务连接配置（配置文件中的条目）。 */
export interface MCPServerEntry {
  /** 服务名（用于日志与工具名前缀）。 */
  name: string;
  /** 启动命令（如 npx / node / 本地二进制）。 */
  command: string;
  /** 命令参数。 */
  args?: string[];
  /** 环境变量（可选）。 */
  env?: Record<string, string>;
}

export interface ConcertoAIConfig {
  schemaVersion: number;
  /** 默认模型 ID（CLI -m / LUMEN_MODEL 优先）。 */
  defaultModel?: string;
  /** 免审批命令白名单前缀（LUMEN_ALLOWLIST 覆盖）。 */
  allowlist?: string[];
  /** 审批策略：ask = 逐个审批（默认）；allowlist-only = 只放行白名单，其余一律拒绝。 */
  approvalPolicy?: ApprovalPolicy;
  /** 会话存储目录（LUMEN_SESSION_DIR 覆盖）。 */
  sessionDir?: string;
  /** 界面语言（LUMEN_LOCALE 覆盖；T4.5 消费）。 */
  locale?: string;
  /** MCP 服务配置列表（v1.1）。 */
  mcpServers?: MCPServerEntry[];
  /** 高峰时段模型切换策略（v2.2）：ask / switch / ignore，默认 ask。 */
  peakTimeStrategy?: PeakTimeStrategy;
  /** 高峰时段切换到的本地模型 ID（Ollama，v2.2）。 */
  ollamaModel?: string;
  /** 本地模型 OpenAI 兼容端点（Ollama /v1，v2.2）。 */
  ollamaBaseUrl?: string;
}

export interface ResolvedConfig {
  /** 解析后的模型 ID；undefined = 用内置默认模型。 */
  model: string | undefined;
  /** 解析后的白名单；undefined = 用内置 DEFAULT_ALLOWLIST。 */
  allowlist: string[] | undefined;
  approvalPolicy: ApprovalPolicy;
  sessionDir: string;
  locale: string;
  /** MCP 服务配置（v1.1）。 */
  mcpServers: MCPServerEntry[];
  /** 高峰时段模型切换策略（v2.2）：ask / switch / ignore，默认 ask。 */
  peakTimeStrategy: PeakTimeStrategy;
  /** 本地模型 ID（Ollama，v2.2）。 */
  ollamaModel: string;
  /** 本地模型 OpenAI 兼容端点（Ollama /v1，v2.2）。 */
  ollamaBaseUrl: string;
}

/** 空配置（默认值由解析层兜底）。 */
export function emptyConfig(): ConcertoAIConfig {
  return { schemaVersion: CONFIG_SCHEMA_VERSION };
}

/** 读取配置文件；不存在 / 损坏 / 版本不匹配时返回空配置（不抛错）。 */
export async function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<ConcertoAIConfig> {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ConcertoAIConfig>;
    if (parsed.schemaVersion !== CONFIG_SCHEMA_VERSION) {
      return emptyConfig();
    }
    return { schemaVersion: CONFIG_SCHEMA_VERSION, ...parsed };
  } catch {
    return emptyConfig();
  }
}

/** 写入配置文件（原子：临时文件 + rename；自动创建目录）。 */
export async function writeConfig(
  config: ConcertoAIConfig,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmp, configPath);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * 合并优先级：CLI 参数 > 环境变量（LUMEN_*）> 配置文件 > 默认值。
 * cliModel / cliLocale 为 CLI 参数（无则 undefined）。
 */
export function resolveConfig(
  file: ConcertoAIConfig,
  cliModel?: string,
  cliLocale?: string,
): ResolvedConfig {
  const model = cliModel ?? env('LUMEN_MODEL') ?? file.defaultModel;

  const allowlistRaw = env('LUMEN_ALLOWLIST') ?? file.allowlist?.join(',') ?? undefined;
  const allowlist =
    allowlistRaw === undefined
      ? undefined
      : allowlistRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');

  const approvalRaw = env('LUMEN_APPROVAL') ?? file.approvalPolicy;
  const approvalPolicy: ApprovalPolicy =
    approvalRaw === 'allowlist-only' ? 'allowlist-only' : 'ask';

  const sessionDir = env('LUMEN_SESSION_DIR') ?? file.sessionDir ?? DEFAULT_SESSION_DIR;
  // locale 优先级：CLI --lang > LUMEN_LOCALE > LANG（zh/en 前缀）> 配置文件 > 'zh'
  const langEnv = env('LANG');
  const langMatch = langEnv !== undefined && /^(zh|en)/i.test(langEnv) ? langEnv : undefined;
  const locale = cliLocale ?? env('LUMEN_LOCALE') ?? langMatch ?? file.locale ?? 'zh';

  // v2.2 智能成本控制：高峰时段策略与本地模型配置（仅配置文件，不支持环境变量）
  const peakTimeStrategy: PeakTimeStrategy =
    file.peakTimeStrategy === 'switch' || file.peakTimeStrategy === 'ignore'
      ? file.peakTimeStrategy
      : DEFAULT_PEAK_TIME_STRATEGY;
  const ollamaModel = file.ollamaModel ?? DEFAULT_OLLAMA_MODEL;
  const ollamaBaseUrl = file.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL;

  return {
    model,
    allowlist,
    approvalPolicy,
    sessionDir,
    locale,
    mcpServers: file.mcpServers ?? [],
    peakTimeStrategy,
    ollamaModel,
    ollamaBaseUrl,
  };
}
