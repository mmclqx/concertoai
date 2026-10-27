/**
 * 配置文件：~/.concertoai/config.json（带 schema 版本字段）。
 *
 * 支持字段：defaultModel（默认模型）、allowlist（命令白名单）、
 * approvalPolicy（ask / allowlist-only）、sessionDir（会话目录）、locale、
 * peakTimeStrategy（高峰时段模型切换策略）、ollamaModel / ollamaBaseUrl
 * （本地模型接入，v2.2 智能成本控制）、pricingHolidays（计价用法定节假日表，v5.0 T7）。
 *
 * 优先级：CLI 参数 > 环境变量（LUMEN_*）> 配置文件 > 默认值。
 * 文件不存在 / JSON 损坏 / schema 版本不匹配 → 返回空配置（不抛错）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { configureHolidayCalendar } from '../core/holidays';
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
  /**
   * 默认模型 ID（CLI -m / LUMEN_MODEL 优先）。
   *
   * v5.0 T6：接受保留值 `'auto'`（自动预设）——含义是「用默认档起步、绝不自动升级」，
   * 入口层由 `resolveModel` 规范化成具体模型 ID 并提示用户实际模型（见 `src/model/auto.ts`）。
   */
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
  /**
   * 计价用中国法定节假日表（v5.0 T7 修订）。
   *
   * 高峰/空闲双档计价必须排除法定节假日、并纳入调休上班日（见 `core/holidays.ts`）。
   * 日期为本地时区 `YYYY-MM-DD`；非法日期在 `loadConfig` 时提示后忽略。
   * 未配置时 `concertoai balance` 会显式提示「未配置节假日表」，**不静默算错**。
   */
  pricingHolidays?: {
    /** 法定节假日（当天按非工作日计价）。 */
    holidays?: string[];
    /** 调休上班日（当天按工作日计价）。 */
    makeupWorkdays?: string[];
  };
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

/**
 * 读取配置文件；不存在 / 损坏 / 版本不匹配时返回空配置（不抛错）。
 *
 * v5.0 T7 修订：读取成功/失败后统一装载 `pricingHolidays`（计价用节假日表）——
 * 日历是**配置的函数**（每次 load 都以当前配置为准，天然幂等），
 * 非法日期在此提示一次（用户改配置打错字必须看得见，不能静默忽略）。
 */
export async function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<ConcertoAIConfig> {
  const config = await readConfigFile(configPath);
  const report = configureHolidayCalendar(config.pricingHolidays);
  if (report.invalid.length > 0) {
    console.error(
      `⚠️ config.pricingHolidays 中有 ${report.invalid.length} 个非法日期已忽略（需 YYYY-MM-DD）：${report.invalid.join(', ')}`,
    );
  }
  return config;
}

/**
 * 摊平 v4 迁移的 `legacy` 子对象到顶层（v5.0 T7 修订）。
 *
 * **为什么需要**：`migrateV3ToV4` 把 v3 的其余字段（allowlist / approvalPolicy /
 * sessionDir / locale / mcpServers / peakTimeStrategy / pricingHolidays…）收进 `legacy` 子对象，
 * 但 `resolveConfig` 等所有消费方读的都是**顶层**字段 → 迁移后用户的白名单、高峰切换策略等
 * 「看似迁移成功、实际全部失效」（v4.0 遗留缺陷；v5.0 T7 因 pricingHolidays 走同一路径被发现）。
 *
 * 规则：**顶层优先**（v4 顶层显式配置永远赢过 legacy 里的旧值），legacy 只补「顶层缺失」的键。
 * 不删除 `legacy` 本身（保留原始迁移痕迹便于排查），也不改写磁盘（读取层兼容，写回仍按新格式）。
 */
function flattenLegacy(parsed: Partial<ConcertoAIConfig>): ConcertoAIConfig {
  const raw = parsed as Partial<ConcertoAIConfig> & { legacy?: Record<string, unknown> };
  const legacy = raw.legacy;
  if (legacy === undefined || typeof legacy !== 'object') {
    return parsed as ConcertoAIConfig;
  }
  const merged: Record<string, unknown> = { ...legacy };
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'legacy' || value === undefined) {
      continue;
    }
    merged[key] = value; // 顶层优先
  }
  return merged as unknown as ConcertoAIConfig;
}

/** 纯读取实现（不含节假日装载副作用，便于单测与迁移路径复用）。 */
async function readConfigFile(configPath: string): Promise<ConcertoAIConfig> {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ConcertoAIConfig> & {
      _migrated?: boolean;
    };
    // v4.0 M3 T3.5：检测到 v3 格式 → 自动迁移（备份 config.v3.bak + 写 v4 格式 + _migrated 幂等）
    // isV3Config 判定：schemaVersion===1 或 无 schemaVersion 但含 defaultModel 且无 defaultProvider
    const { isV3Config, migrateV3ToV4 } = await import('./migration');
    if (isV3Config(parsed)) {
      const result = await migrateV3ToV4(parsed as ConcertoAIConfig, configPath);
      if (result.migrated) {
        // 迁移成功 → 返回迁移后的配置（v4 形态：schemaVersion=2 + defaultProvider + providers）
        const migrated = await readFile(configPath, 'utf8');
        return flattenLegacy(JSON.parse(migrated) as Partial<ConcertoAIConfig>);
      }
      // 迁移失败（备份失败等）→ 返回原配置（保持兼容读取，不阻塞启动）
      return { schemaVersion: CONFIG_SCHEMA_VERSION, ...parsed };
    }
    // v4 格式（schemaVersion=2）→ 读取并摊平迁移遗留字段（见 flattenLegacy）
    if (parsed.schemaVersion === 2) {
      return flattenLegacy(parsed);
    }
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
/**
 * 从配置解析生效模型（v4.0 M3 T3.5）：
 * - v4 格式（defaultProvider + providers）：model = providers[defaultProvider].model，
 *   CLI -m 优先（映射到 defaultProvider.model，保持兼容）；
 * - v3 格式（defaultModel）：直通（迁移前兼容读取）。
 */
export function resolveModelFromConfig(
  file: ConcertoAIConfig,
  cliModel?: string,
): string | undefined {
  const fileV4 = file as ConcertoAIConfig & {
    defaultProvider?: string;
    providers?: Record<string, { model?: string }>;
  };
  if (cliModel !== undefined) {
    return cliModel;
  }
  const envModel = env('LUMEN_MODEL');
  if (envModel !== undefined) {
    return envModel;
  }
  if (fileV4.defaultProvider !== undefined && fileV4.providers !== undefined) {
    const provider = fileV4.providers[fileV4.defaultProvider];
    if (provider?.model !== undefined) {
      return provider.model;
    }
  }
  return file.defaultModel;
}

export function resolveConfig(
  file: ConcertoAIConfig,
  cliModel?: string,
  cliLocale?: string,
): ResolvedConfig {
  const model = resolveModelFromConfig(file, cliModel);

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
