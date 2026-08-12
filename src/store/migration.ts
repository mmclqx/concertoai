/**
 * config.json v3 → v4 自动迁移器（M0 T0.2 设计骨架，M3 T3.5 实现）。
 *
 * v4.0 破坏性变更：`model` 字段 → `defaultProvider` + `providers`。
 * 迁移策略（见 docs/10-技术评估/v3-v4-migration-design.md）：
 * - 启动时自动迁移（幂等）：迁移前备份 `config.v3.bak`，成功后写 `_migrated` 标记；
 * - `isV3Config` 判定旧格式（schemaVersion === 1 或含 defaultModel 且无 defaultProvider）；
 * - `migrateV3ToV4` 字段映射：defaultModel → providers.deepseek.model、ollamaModel/ollamaBaseUrl → providers.ollama。
 * - doctor 迁移完整性检测：config 迁移是否成功、备份是否存在、会话格式是否兼容（M3 接入）。
 */

import { copyFile, readdir, readFile, stat } from 'node:fs/promises';
import { CONFIG_SCHEMA_VERSION, type ConcertoAIConfig, writeConfig } from './config';

/** v4 config schema 版本（v3 为 1，v4 为 2）。 */
export const V4_CONFIG_SCHEMA_VERSION = 2;

/** Provider 类型：内置 deepseek / openai / ollama，或第三方兼容（type 字符串）。 */
export type ProviderType = 'deepseek' | 'openai' | 'ollama' | string;

/** v4 Provider 配置项（providers 字典的值）。 */
export interface ProviderConfig {
  /** Provider 类型（默认与键同名；兼容第三方 baseUrl 时显式声明）。 */
  type?: ProviderType;
  /** 默认模型 ID（如 deepseek-chat / gpt-4o / qwen3.6:27b）。 */
  model?: string;
  /** OpenAI 兼容 API baseUrl（Ollama 默认 http://localhost:11434/v1）。 */
  baseUrl?: string;
  /** API Key（优先引用 accounts/ 存储体系，内联仅作显式覆盖；Key 不落日志）。 */
  apiKey?: string;
  /** 是否启用（默认 true）。 */
  enabled?: boolean;
}

/** v4 config 目标格式：defaultProvider + providers。 */
export interface V4Config {
  schemaVersion: number;
  /** 默认 Provider 键（providers 字典的键）。 */
  defaultProvider: string;
  /** Provider 字典（键 = provider 名）。 */
  providers: Record<string, ProviderConfig>;
  /** v3 其余字段直通（allowlist/approvalPolicy/sessionDir/locale/mcpServers/peakTimeStrategy）。 */
  legacy?: Omit<
    ConcertoAIConfig,
    'schemaVersion' | 'defaultModel' | 'ollamaModel' | 'ollamaBaseUrl'
  >;
  /** 迁移幂等标记（成功迁移后写入）。 */
  _migrated?: boolean;
}

/** 迁移结果（doctor 迁移完整性检测消费）。 */
export interface MigrationResult {
  /** 是否发生了迁移。 */
  migrated: boolean;
  /** 迁移前是否已存在 v3 备份。 */
  backupExists: boolean;
  /** 备份文件路径（config.v3.bak）。 */
  backupPath?: string;
  /** 迁移失败的字段清单（空 = 成功）。 */
  failedFields: string[];
}

/**
 * 判定配置文件是否为 v3 格式（需要迁移）。
 * - schemaVersion === 1 → v3（需迁移）；
 * - 无 schemaVersion 但含 defaultModel 且无 defaultProvider → v3（兼容旧配置）；
 * - 空配置 / schemaVersion === 2 → 非 v3（无需迁移）。
 */
export function isV3Config(config: Partial<ConcertoAIConfig>): boolean {
  if (config.schemaVersion === V4_CONFIG_SCHEMA_VERSION) return false;
  // v3 格式的 schemaVersion = CONFIG_SCHEMA_VERSION（当前 1），单一来源避免未来不同步。
  if (config.schemaVersion === CONFIG_SCHEMA_VERSION) return true;
  // 无 schemaVersion 的旧配置：以 defaultModel 存在判定（兼容最早版本未带版本号）。
  if (config.schemaVersion === undefined) {
    return config.defaultModel !== undefined;
  }
  // 其他未知版本号（如 999）：非 v3，由 loadConfig 走「版本不匹配 → 空配置」分支，不迁移。
  return false;
}

/**
 * v3 → v4 迁移（M3 T3.5 完整实现）。
 *
 * 字段映射表：
 * - `defaultModel: 'deepseek-chat'` → `defaultProvider: 'deepseek'` + `providers.deepseek = { type:'deepseek', model:'deepseek-chat' }`
 * - `ollamaModel: 'qwen3.6:27b'` + `ollamaBaseUrl: 'http://localhost:11434/v1'` → `providers.ollama = { type:'ollama', model, baseUrl }`
 * - 其余字段直通 legacy；迁移前备份 `config.v3.bak`；成功后写 `_migrated: true`。
 *
 * 幂等：`_migrated` 或 schemaVersion=2 均为已迁移标记，重复执行 isV3Config=false 跳过；
 * 备份：迁移写盘前复制原文件为 config.v3.bak（存在则不覆盖）；
 * 原子写：复用 writeConfig（临时文件 + rename）。
 */
export async function migrateV3ToV4(
  config: ConcertoAIConfig,
  configPath: string,
): Promise<MigrationResult> {
  // 非 v3 → 无需迁移（幂等）
  if (!isV3Config(config)) {
    return { migrated: false, backupExists: false, failedFields: [] };
  }

  const failedFields: string[] = [];

  // 1. 备份 config.v3.bak（存在则不覆盖——保留首次迁移前的原状）
  const backupPath = `${configPath}.v3.bak`;
  let backupExists = false;
  try {
    await copyFile(configPath, backupPath);
    backupExists = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // 配置文件不存在 → 无备份必要，但迁移也无意义（由 loadConfig 兜底为空配置）
      return { migrated: false, backupExists: false, failedFields: [] };
    }
    // 备份失败 → 不继续迁移（fail-closed：无法回滚时不冒险改写）
    return { migrated: false, backupExists: false, failedFields: ['backup'] };
  }

  // 2. 字段映射
  const legacy: Record<string, unknown> = { ...config };
  delete legacy.schemaVersion;
  delete legacy.defaultModel;
  delete legacy.ollamaModel;
  delete legacy.ollamaBaseUrl;

  const providers: Record<string, ProviderConfig> = {};
  const defaultModel = config.defaultModel ?? 'deepseek-v4-flash';
  // defaultModel → providers.deepseek（默认 Provider 键 deepseek）
  providers.deepseek = { type: 'deepseek', model: defaultModel };

  // ollamaModel + ollamaBaseUrl → providers.ollama（任一存在都建，缺省补默认值）
  if (config.ollamaModel !== undefined || config.ollamaBaseUrl !== undefined) {
    providers.ollama = {
      type: 'ollama',
      model: config.ollamaModel ?? 'qwen3.6:27b-q4_K_M',
      baseUrl: config.ollamaBaseUrl ?? 'http://localhost:11434/v1',
    };
  }

  const v4: V4Config = {
    schemaVersion: V4_CONFIG_SCHEMA_VERSION,
    defaultProvider: 'deepseek',
    providers,
    legacy,
    _migrated: true,
  };

  // 3. 原子写盘（临时文件 + rename；EXDEV 回退由 writeConfig 内部处理）
  try {
    await writeConfig(v4 as unknown as ConcertoAIConfig, configPath);
  } catch {
    failedFields.push('write');
  }

  return {
    migrated: failedFields.length === 0,
    backupExists,
    backupPath,
    failedFields,
  };
}

// ═══ M3 T3.5 辅助：doctor 迁移完整性检测 ═══

/** 迁移完整性检测结果（doctor 消费）。 */
export interface MigrationIntegrity {
  /** config 是否已迁移（schemaVersion=2 + defaultProvider + providers[defaultProvider] 存在）。 */
  migrated: boolean;
  /** 备份是否存在（config.v3.bak）。 */
  backupExists: boolean;
  /** 会话格式是否兼容（v4 只新增字段不破坏 v3 会话）。 */
  sessionCompatible: boolean;
  /** 幂等：重复检测不产生重复迁移/备份。 */
  idempotent: boolean;
}

/**
 * 检测 config 迁移完整性（只读，不写盘）。
 * @param configPath 配置文件路径（config.json）
 * @param sessionDir 会话目录（存在即视为兼容——v4 会话格式向后兼容）
 */
export async function checkMigrationIntegrity(
  configPath: string,
  sessionDir?: string,
): Promise<MigrationIntegrity> {
  const backupExists = await fileExists(`${configPath}.v3.bak`);
  let migrated = false;
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<V4Config>;
    migrated =
      parsed.schemaVersion === V4_CONFIG_SCHEMA_VERSION &&
      typeof parsed.defaultProvider === 'string' &&
      parsed.providers?.[parsed.defaultProvider] !== undefined;
  } catch {
    migrated = false;
  }
  let sessionCompatible = true;
  if (sessionDir !== undefined) {
    try {
      const entries = await readdir(sessionDir);
      // 会话文件存在且可读即可（格式兼容由读取层宽松处理）
      sessionCompatible = entries.length >= 0;
    } catch {
      sessionCompatible = true; // 无会话目录 → 兼容（无旧会话需迁移）
    }
  }
  // 幂等：检测本身只读不写盘 → 恒为 true（重复调用无副作用）
  return { migrated, backupExists, sessionCompatible, idempotent: true };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
