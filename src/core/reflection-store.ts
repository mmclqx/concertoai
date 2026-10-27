/**
 * 拒绝复盘记录（v5.0 T10，ADR-042 / §4 D72）。
 *
 * ## 这是什么
 *
 * 用户按下 `n` 拒绝一次编辑时，把「拒的是什么、为什么可能危险、我当时想干什么」写成
 * 一行 JSONL 落到本地。目的是让「我拒绝过的原因能被记住」——而不是第二天再看到
 * 一模一样的高风险改动时，又靠记忆重新判断一遍。
 *
 * ## 三条铁律
 *
 * | # | 铁律 | 落地 |
 * |---|---|---|
 * | G8 | **零网络、默认本地** | 只写本地文件，`fetch`/`http`/`net` 一个都不 import（有护栏测试扫源码）；不做任何上报 |
 * | G2' | **写盘失败绝不阻塞审批** | `appendReflection` 内部全 `try/catch`，**永不抛错**、永不 reject；调用方 fire-and-forget（`void`），审批决议早就 resolve 完了 |
 * | — | **必须能关掉** | `config.reflections = 'off'` 或环境变量 `CONCERTOAI_REFLECTIONS=off`（双轨）；关掉后拒绝照常工作，只是不写 |
 *
 * ## 为什么 O_APPEND
 *
 * 复盘是**只追加的流水**：一条记录几十到几百字节，一天几十条。用
 * 「读全文件 → 拼接 → 覆写」在记录变多后是 O(n) 全量重写（v2.1 会话存储踩过同一个坑，
 * 见 `store/session.ts` 的 `appendLocked`）。`appendFile` 走 `O_APPEND`，单次写入 O(1)，
 * 且进程被 Ctrl+C 打断最多留下半行——读取端宽容跳过（`skipped` 计数如实上报）。
 *
 * ## 为什么单独一个文件而不是塞进会话 JSONL
 *
 * 会话是「一次对话」，复盘是「跨会话的判断记录」：会话可能被删、可能 resume 到别的机器
 * 路径下，而复盘要能 `reflect list` 一眼看到最近 20 条。混在一起会让两件事互相绑架。
 */

import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { reflectionsPath } from '../store/paths';
import type { RiskLevel } from './risk-rules';

/** 复盘记录决策（当前只有「拒绝」；批准不进复盘——那是用户认可的行为，无复盘价值）。 */
export type ReflectionDecision = 'rejected';

/**
 * 一条复盘记录。
 *
 * 字段刻意保持**扁平且短**：这是流水，不是分析报告；需要细节时用户回到审批现场去改，
 * 复盘只负责「想起来」。`why` / `suggestion` 这类长文案不入库（会迅速把文件撑大）。
 */
export interface ReflectionEntry {
  /** 毫秒时间戳。 */
  ts: number;
  /** 项目名（`cwd` 的 basename；推导不出时为 `unknown`）。 */
  project: string;
  /** 被拒绝的目标文件（相对 cwd；无文件上下文时为空串）。 */
  file: string;
  /**
   * 风险等级。
   *
   * **`unknown` 不是 `low`**：分析被跳过 / 降级（CI、非 TTY、超大 diff、抛错、关掉）时
   * 我们并不知道风险高低，谎报 `low` 会让复盘记录失去意义（同 T9 措辞红线②的精神）。
   */
  level: RiskLevel | 'unknown';
  /** 命中的风险类别（去重、最多 5 条；`level` 为 unknown 时为空）。 */
  categories: string[];
  /** 建议重点关注行（diff 行下标，最多 10 条）。 */
  focusLines: number[];
  /** AI 意图摘要（来自 `ApprovalRequest.insightHint.intent`；无则空串）。 */
  intent: string;
  /** 用户选择。 */
  decision: ReflectionDecision;
}

/** 写入结果（调用方**不需要**处理失败——它只是「能不能看到」的依据）。 */
export interface ReflectionWriteResult {
  ok: boolean;
  /** 失败原因（仅用于诊断，不面向普通用户）。 */
  error?: string;
}

/** 读取结果。 */
export interface ReflectionReadResult {
  /** 按时间**倒序**（最新在前）。 */
  entries: ReflectionEntry[];
  /** 跳过的损坏行数（半行 / 手动编辑 / 非 JSON）。 */
  skipped: number;
}

/** 每类字段的上限（防单条记录把文件撑大）。 */
export const MAX_CATEGORIES = 5;
export const MAX_FOCUS_LINES = 10;

/** 读取类操作的注入选项（测试用 tmp 目录/文件）。 */
export interface ReflectionStoreOptions {
  /** 文件路径（缺省 `~/.concertoai/reflections.jsonl`）。 */
  file?: string;
  /** 时钟注入（缺省 `Date.now`）。 */
  now?: () => number;
  /** 项目名注入（缺省从 `cwd` 推导）。 */
  project?: string;
}

/** 复盘文件路径（单一来源：`store/paths.ts`）。 */
export function defaultReflectionsPath(): string {
  return reflectionsPath();
}

/** 关闭语义的写法（大小写不敏感）。 */
const OFF_VALUES = new Set(['off', 'false', '0', 'no']);
/** 开启语义的写法（大小写不敏感）。 */
const ON_VALUES = new Set(['on', 'true', '1', 'yes']);

/** 把取值解析为布尔；无法识别 → undefined（**不猜**）。 */
function parseSwitchValue(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') {
    return undefined;
  }
  if (OFF_VALUES.has(normalized)) {
    return false;
  }
  if (ON_VALUES.has(normalized)) {
    return true;
  }
  return undefined;
}

/**
 * 复盘开关（双轨：环境变量 > config；默认 **on**）。
 *
 * 环境变量优先于 config，与全项目「CLI 参数 > 环境变量 > 配置文件 > 默认值」一致。
 *
 * **无法识别的值一律忽略、回落到下一层**（不是「按 on」）：
 * 把 `CONCERTOAI_REFLECTIONS=ofl` 这类手滑当成 "on"，会**静默覆盖**用户配置文件里
 * 明确写的 `off` —— 用户以为关掉了，实际一直在记。测试实测报红的就是这个语义
 * （`环境变量写错值 → 回落配置文件`）。
 */
export function isReflectionsEnabled(configValue?: string, envValue?: string): boolean {
  const fromEnv = parseSwitchValue(envValue);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const fromConfig = parseSwitchValue(configValue);
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  return true;
}

/** 从 cwd 推导项目名（推导不出 → `unknown`，不编造）。 */
export function projectNameOf(cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim() === '') {
    return 'unknown';
  }
  const base = path.basename(cwd.trim());
  return base === '' || base === '.' || base === '..' ? 'unknown' : base;
}

/** `buildReflection` 的输入（刻意窄：UI 只交它能提供的事实）。 */
export interface BuildReflectionInput {
  /** 目标文件（相对 cwd；无则 undefined）。 */
  file?: string;
  /** 风险洞察；null / undefined = 未分析（→ level `unknown`）。 */
  level?: RiskLevel | null;
  /** 命中类别（会去重 + 截断）。 */
  categories?: readonly string[];
  /** 建议关注行（会截断）。 */
  focusLines?: readonly number[];
  /** AI 意图摘要。 */
  intent?: string;
  /** 项目名（缺省用 `cwd` 推导）。 */
  project?: string;
  /** cwd（推导 project 用）。 */
  cwd?: string;
  /** 时钟注入。 */
  now?: () => number;
}

/**
 * 纯函数：把「审批现场的事实」组装成一条复盘记录。
 *
 * 无 IO、无副作用 → 字段规则（去重/截断/unknown 兜底）可以纯单测覆盖，
 * 不用造文件系统。
 */
export function buildReflection(input: BuildReflectionInput): ReflectionEntry {
  const now = input.now ?? (() => Date.now());
  const categories = [...new Set((input.categories ?? []).filter((c) => c !== ''))].slice(
    0,
    MAX_CATEGORIES,
  );
  const focusLines = [...new Set(input.focusLines ?? [])].slice(0, MAX_FOCUS_LINES);
  return {
    ts: now(),
    project: input.project ?? projectNameOf(input.cwd),
    file: input.file ?? '',
    // 未分析 ≠ 低风险：没有 level 就写 unknown（T9 措辞红线②的同一套价值观）
    level: input.level ?? 'unknown',
    categories: input.level === null || input.level === undefined ? [] : categories,
    focusLines,
    intent: input.intent ?? '',
    decision: 'rejected',
  };
}

/**
 * 追加一条复盘记录（**永不抛错**）。
 *
 * - 目录不存在 → 自动创建（`recursive`）；
 * - `O_APPEND`（`appendFile` 的 `a` 标志）单次追加，不重写历史；
 * - **任何失败都返回 `{ ok: false }` 而不是抛错**：复盘是可选便利功能，
 *   目录只读 / 磁盘满都不该让用户的审批流程卡住或崩掉（G2 精神 / G8）。
 */
export async function appendReflection(
  entry: ReflectionEntry,
  options: ReflectionStoreOptions = {},
): Promise<ReflectionWriteResult> {
  const file = options.file ?? defaultReflectionsPath();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    // O_APPEND：只追加，绝不重写（见文件头「为什么 O_APPEND」）
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 校验一行 JSON 是否为合法复盘记录（缺字段/类型不对 → 视为损坏行跳过）。 */
function parseReflectionLine(line: string): ReflectionEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
    return null;
  }
  if (typeof obj.file !== 'string' || typeof obj.project !== 'string') {
    return null;
  }
  const level = obj.level;
  if (level !== 'high' && level !== 'medium' && level !== 'low' && level !== 'unknown') {
    return null;
  }
  return {
    ts: obj.ts,
    project: obj.project,
    file: obj.file,
    level,
    categories: Array.isArray(obj.categories)
      ? obj.categories.filter((c): c is string => typeof c === 'string')
      : [],
    focusLines: Array.isArray(obj.focusLines)
      ? obj.focusLines.filter((n): n is number => typeof n === 'number')
      : [],
    intent: typeof obj.intent === 'string' ? obj.intent : '',
    // 当前只有 rejected 一种决策；未来新增（如 approved-after-edit）在写入侧扩展，
    // 读取侧对未知值一律按 rejected 归档（历史数据永远可读）
    decision: 'rejected',
  };
}

/**
 * 读取复盘记录（按时间**倒序**）。
 *
 * - 文件不存在 → 空结果（首次运行不报错）；
 * - 损坏行（半行 / 手改 / 非 JSON / 字段缺失）→ 跳过并计数，**不中断读取**；
 * - `limit` 只影响返回条数（内部仍要全读才能保证「最新 N 条」正确）。
 */
export async function readReflections(
  options: ReflectionStoreOptions & { limit?: number } = {},
): Promise<ReflectionReadResult> {
  const file = options.file ?? defaultReflectionsPath();
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return { entries: [], skipped: 0 };
  }
  // 用「行号」显式记录写入顺序：同一毫秒内的多条记录也必须「后写的在上」
  // （否则排序不稳定，`reflect list` 的先后会随 V8 排序实现漂移）
  const collected: { order: number; entry: ReflectionEntry }[] = [];
  let skipped = 0;
  let order = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const entry = parseReflectionLine(trimmed);
    if (entry === null) {
      skipped += 1;
      continue;
    }
    collected.push({ order, entry });
    order += 1;
  }
  collected.sort((a, b) =>
    b.entry.ts !== a.entry.ts ? b.entry.ts - a.entry.ts : b.order - a.order,
  );

  const limit = options.limit;
  const picked = limit !== undefined && limit > 0 ? collected.slice(0, limit) : collected;
  return { entries: picked.map((item) => item.entry), skipped };
}

/**
 * 清空复盘记录（**永不抛错**）。
 *
 * 文件本来就不存在 → 视为成功（`removed: false`）：`reflect clear` 在空目录上重复执行
 * 不该报错（幂等）。
 */
export async function clearReflections(
  options: ReflectionStoreOptions = {},
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const file = options.file ?? defaultReflectionsPath();
  try {
    await rm(file, { force: true });
    return { ok: true, removed: true };
  } catch (error) {
    // force: true 已吞掉 ENOENT；走到这里是真失败（权限等）
    return {
      ok: false,
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
