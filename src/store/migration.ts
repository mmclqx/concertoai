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

import { CONFIG_SCHEMA_VERSION, type ConcertoAIConfig } from './config';

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
  // 无 schemaVersion 的旧配置：以 defaultModel 存在且无 defaultProvider 判定（v4 格式由调用方先判断）。
  return config.defaultModel !== undefined;
}

/**
 * v3 → v4 迁移（M0 骨架：签名与字段映射表，实现归 M3 T3.5）。
 *
 * 字段映射表：
 * - `defaultModel: 'deepseek-chat'` → `defaultProvider: 'deepseek'` + `providers.deepseek = { type:'deepseek', model:'deepseek-chat' }`
 * - `ollamaModel: 'qwen3.6:27b'` + `ollamaBaseUrl: 'http://localhost:11434/v1'` → `providers.ollama = { type:'ollama', model, baseUrl }`
 * - 其余字段直通 legacy；迁移前备份 `config.v3.bak`；成功后写 `_migrated: true`。
 */
export async function migrateV3ToV4(
  config: ConcertoAIConfig,
  configPath: string,
): Promise<MigrationResult> {
  // TODO(M3 T3.5): 实现备份（config.v3.bak）+ 字段映射 + 幂等标记 + 原子写盘。
  void config;
  void configPath;
  return {
    migrated: false,
    backupExists: false,
    failedFields: ['migrateV3ToV4 not implemented (M3 T3.5)'],
  };
}
