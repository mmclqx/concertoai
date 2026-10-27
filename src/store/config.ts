/**
 * 配置文件：~/.concertoai/config.json（带 schema 版本字段）。
 *
 * 支持字段：defaultModel（默认模型）、allowlist（命令白名单）、
 * approvalPolicy（ask / allowlist-only）、sessionDir（会话目录）、locale、
 * peakTimeStrategy（高峰时段模型切换策略）、ollamaModel / ollamaBaseUrl
 * （本地模型接入，v2.2 智能成本控制）、pricingHolidays（计价用法定节假日表，v5.0 T7）、
 * approvalInsight / riskRules（审批卡形态与规则开关，v5.0 T8-T11）、
 * reflections（拒绝复盘开关，v5.0 T10）、hints（场景提示开关，v5.0 T12）。
 *
 * 优先级：CLI 参数 > 环境变量（LUMEN_*）> 配置文件 > 默认值。
 * 文件不存在 / JSON 损坏 / schema 版本不匹配 → 返回空配置（不抛错）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { configureHolidayCalendar } from '../core/holidays';
import { isReflectionsEnabled } from '../core/reflection-store';
import { isHintsEnabled } from '../core/suggestion';
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

/**
 * 审批卡形态（v5.0 T8/T9/T11）：
 * - `rich`：风险教学卡（默认）；
 * - `plain`：v4.1.1 原貌（只 summary + diff + 按键），逐字节等价。
 *
 * 非 TTY / CI / 超大 diff 时**自动降级为 plain**，判定逻辑唯一来源是
 * `core/approval-insight.ts` 的降级矩阵（本文件只负责「用户想用哪种」，不重复判断环境）。
 */
export type ApprovalInsightMode = 'rich' | 'plain';

/** 审批卡形态默认值（rich）。 */
export const DEFAULT_APPROVAL_INSIGHT: ApprovalInsightMode = 'rich';

/** 拒绝复盘记录开关（v5.0 T10）：`on` = 拒绝时记一条本地 JSONL（默认）；`off` = 不记，拒绝照常。 */
export type ReflectionsMode = 'on' | 'off';

/** 复盘记录默认值（on：功能默认可用，但纯本地零上传，见 ADR-042）。 */
export const DEFAULT_REFLECTIONS: ReflectionsMode = 'on';

/**
 * 场景提示开关（v5.0 T12）：`on` = 卡住时给一条可执行命令（默认）；`off` = 恒不提示。
 *
 * **默认开启但极保守**（用户拍板，见 `docs/03-开发计划与任务/v5.0-M3-kickoff.md`）：
 * 三条确定性规则 + 每会话总量上限 3 条 + 全局 10 分钟冷却 + Esc 即静默。
 * 用户嫌烦可 `concertoai config set hints off` 或 chat 内 `/hints off` 一键静音。
 * （两处入口均已实现——提示里承诺的命令必须真能用，见 ADR-044。）
 */
export type HintsMode = 'on' | 'off';

/** 场景提示默认值（on：默认可用；噪音风险由引擎侧七条硬约束兜住，不靠「默认关」回避）。 */
export const DEFAULT_HINTS: HintsMode = 'on';

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
   * 审批洞察模式（v5.0 T8）：`rich` = 风险教学卡（默认）；`plain` = v4.1.1 原貌（只 summary + diff）。
   *
   * 环境不满足时（非 TTY / CI）程序会自动降级为 plain，无需手动配置。
   */
  approvalInsight?: ApprovalInsightMode;
  /**
   * 风险规则配置（v5.0 T8）。
   *
   * **只允许「关」，不允许「加」自定义正则规则**：规则表跑在审批热路径上，
   * 用户手写正则既无法保证 ReDoS 安全（D69 第三条红线），也无法保证误报率——
   * 一次 high 级误报就会让用户此后忽略所有提示。故本字段刻意只开放 `disabled`（见 D72）。
   */
  riskRules?: {
    /** 关闭的规则 id（如 `['dependency-change']`）；未知 id 静默忽略。 */
    disabled?: string[];
  };
  /**
   * 拒绝复盘记录开关（v5.0 T10）：`on`（默认）/ `off`。
   *
   * 关掉后拒绝**照常工作**，只是不写记录；也可用环境变量 `CONCERTOAI_REFLECTIONS=off` 临时关。
   */
  reflections?: ReflectionsMode;
  /**
   * 场景提示开关（v5.0 T12，用户拍板命名 `hints`——提示的是「下一步该做什么」，
   * 比 `tips`（小技巧）语义更准）：`on`（默认）/ `off`。
   *
   * 关掉后 chat 界面**完全不渲染**提示行；也可用环境变量 `CONCERTOAI_HINTS=off` 临时关。
   */
  hints?: HintsMode;
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
  /**
   * 审批卡形态（v5.0 T11）：**已合并环境变量**的最终值。
   *
   * 消费者（chat.tsx / App）只读这个字段，不要自己再读 `config.approvalInsight`
   * 或环境变量——否则「配置文件 vs 环境变量」的优先级会被各入口实现成两套。
   */
  approvalInsight: ApprovalInsightMode;
  /** 拒绝复盘开关（v5.0 T10/T11）：已合并环境变量的最终值。 */
  reflections: ReflectionsMode;
  /**
   * 场景提示开关（v5.0 T12）：**已合并环境变量**的最终值。
   *
   * 与 `approvalInsight` / `reflections` 同口径：消费者（App）只读这个字段，
   * 不要自己再读 `config.hints` 或环境变量——否则优先级会被各入口实现成两套。
   */
  hints: HintsMode;
}

/** 一条配置值非法记录（供 `loadConfig` 统一提示 + 单测断言，不抛错）。 */
export interface ConfigValidationIssue {
  /** 出问题的字段名（顶层名，如 `reflections`）。 */
  key: string;
  /** 用户填的原始值（提示里原样回显，便于用户定位）。 */
  value: unknown;
  /** 允许的取值说明。 */
  expected: string;
}

/**
 * 校验枚举类配置项的取值（v5.0 T11）。
 *
 * 设计取向：**非法值不抛错、不静默吞掉**——返回问题清单，由 `loadConfig` 提示一次后
 * 按默认值继续工作（配置写错一个字不该让 CLI 起不来），但用户必须看得见（`console.error`）。
 * 这与 `pricingHolidays` 非法日期的处理口径一致。
 */
export function validateConfigValues(config: ConcertoAIConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (config.approvalInsight !== undefined && !isApprovalInsightMode(config.approvalInsight)) {
    issues.push({
      key: 'approvalInsight',
      value: config.approvalInsight,
      expected: 'rich | plain',
    });
  }
  if (
    config.reflections !== undefined &&
    config.reflections !== 'on' &&
    config.reflections !== 'off'
  ) {
    issues.push({ key: 'reflections', value: config.reflections, expected: 'on | off' });
  }
  // v5.0 T12：提示开关（同样是枚举，写错字必须让用户看见）
  if (config.hints !== undefined && !isHintsMode(config.hints)) {
    issues.push({ key: 'hints', value: config.hints, expected: 'on | off' });
  }
  const disabled = config.riskRules?.disabled;
  if (
    disabled !== undefined &&
    (!Array.isArray(disabled) || disabled.some((id) => typeof id !== 'string'))
  ) {
    issues.push({
      key: 'riskRules.disabled',
      value: disabled,
      expected: 'string[]（规则 id 数组）',
    });
  }
  return issues;
}

/** 是否为合法审批卡形态。 */
export function isApprovalInsightMode(value: unknown): value is ApprovalInsightMode {
  return value === 'rich' || value === 'plain';
}

/** 是否为合法复盘开关。 */
export function isReflectionsMode(value: unknown): value is ReflectionsMode {
  return value === 'on' || value === 'off';
}

/** 是否为合法提示开关（v5.0 T12）。 */
export function isHintsMode(value: unknown): value is HintsMode {
  return value === 'on' || value === 'off';
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
  // v5.0 T11：枚举类配置非法值提示一次（不抛错、不静默——写错字不能让 CLI 起不来，
  // 但用户必须知道自己的配置没生效，见 validateConfigValues 的设计取向）
  const issues = validateConfigValues(config);
  for (const issue of issues) {
    console.error(
      `⚠️ config.${issue.key} 的值 ${JSON.stringify(issue.value)} 无效（应为 ${issue.expected}），已按默认值处理。`,
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

  // v5.0 T11：审批卡形态（环境变量 CONCERTOAI_APPROVAL_INSIGHT 覆盖 config）
  //
  // ⚠️ 非法环境变量**必须忽略并回落 config**，不能直接落默认值：
  // 用户配置文件里明确写了 `plain`，而 CI 里手滑写了 `CONCERTOAI_APPROVAL_INSIGHT=plian`，
  // 若按「env 优先 → 非法 → 默认 rich」处理，等于用一次手滑**静默推翻用户的有效配置**。
  // 实测由 config.test.ts「环境变量写错值 → 回落配置文件」报红捕获。
  const envInsight = env('CONCERTOAI_APPROVAL_INSIGHT');
  const approvalInsight: ApprovalInsightMode = isApprovalInsightMode(envInsight)
    ? envInsight
    : isApprovalInsightMode(file.approvalInsight)
      ? file.approvalInsight
      : DEFAULT_APPROVAL_INSIGHT;

  // v5.0 T10/T11：复盘开关（环境变量优先于 config；`off/false/0/no` 均视为关）
  const reflections: ReflectionsMode = isReflectionsEnabled(
    file.reflections,
    env('CONCERTOAI_REFLECTIONS') ?? env('LUMEN_REFLECTIONS'),
  )
    ? 'on'
    : 'off';

  // v5.0 T12：场景提示开关（环境变量 CONCERTOAI_HINTS 优先于 config）
  //
  // 与 approvalInsight / reflections 同一套「非法值回落下一层」语义：
  // 手滑写 `CONCERTOAI_HINTS=ofl` 时若按默认 on 处理，等于用一次手滑**静默推翻**
  // 用户配置里明确写的 `off`（用户以为静音了，实际一直在提示）。
  const hints: HintsMode = isHintsEnabled(file.hints, env('CONCERTOAI_HINTS') ?? env('LUMEN_HINTS'))
    ? 'on'
    : 'off';

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
    approvalInsight,
    reflections,
    hints,
  };
}
