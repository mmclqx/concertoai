/**
 * 本地体验指标（v5.0 T21，ADR-049 / §4 D86-D87）。
 *
 * ## 这是什么
 *
 * 「v5.0 到底变好了没有」需要可度量、可复盘的数字：审批平均耗时、拒绝率、提示采纳率、
 * 体检通过率、动词使用分布。这些数字**只对用户自己有意义**，所以：
 *
 * | # | 铁律 | 落地 |
 * |---|---|---|
 * | 1 | **默认关**（`config.metrics` 缺省 `off`） | 不开就**一个字节都不写**，连文件都不创建（有用例断言） |
 * | 2 | **零网络** | 本文件只 import `node:fs/promises` / `node:path` / 本地路径模块；`fetch`/`http`/`axios` 一个都没有（有源码护栏用例扫） |
 * | 3 | **不干扰主流程** | `appendMetric` 内全 `try/catch`，**永不抛错**、永不 reject；调用方 fire-and-forget |
 * | 4 | **不记内容** | 事件里**没有文件路径、没有代码片段、没有提示词**——只有「耗时/决策/计数/动词名」这类结构化数字 |
 *
 * ## 为什么是 JSONL + O_APPEND
 *
 * 与 `reflection-store.ts` 同一套理由：只追加的流水，单次写入 O(1)，进程被 Ctrl+C
 * 打断最多留半行（读取端宽容跳过并计数）。不做数据库：这里最多几百条，装不进一个
 * 存储层抽象的成本。
 *
 * ## 轮转（防止无限膨胀）
 *
 * 追加后若行数超过 `MAX_METRICS_ENTRIES`(1000)，立刻轮转为最近 `KEEP_METRICS_ENTRIES`(500) 行
 * （临时文件 + rename 原子写）。**为什么按行数而不是时间**：用户在意的是「文件别无限长」，
 * 行数上限最直观；为什么保留 500 而不是清空：指标的价值在趋势，清空会让「我刚开的开关
 * 为什么没有数据」变成新的困惑。
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { metricsPath } from '../store/paths';
import type { RiskLevel } from './risk-rules';

// ── 事件类型 ──

/** 四类事件（对应 v5.0 四个可度量的改进点）。 */
export type MetricsKind = 'approval' | 'suggestion' | 'check' | 'verb';

/** 被记录的四个动词（M4 落地的那四个；`self-heal` 是 `fix` 的旧名，归入 `fix`）。 */
export type MetricsVerb = 'check' | 'fix' | 'commit' | 'review';

/** 审批耗时 + 决策 + 风险等级（**不含文件路径**，G8 隐私）。 */
export interface ApprovalMetric {
  ts: number;
  kind: 'approval';
  /** 从弹出审批框到用户按键的毫秒数（负值/非有限值一律归零，见 `normalizeDuration`）。 */
  durationMs: number;
  decision: 'approved' | 'rejected';
  /** 风险等级；`unknown` = 未分析（降级 / 分析未到达）——**不冒充 low**（同 D72）。 */
  level: RiskLevel | 'unknown';
}

/** 提示出现与其后被采纳的情况（`adopted` 三态，见下方说明）。 */
export interface SuggestionMetric {
  ts: number;
  kind: 'suggestion';
  /** 规则 id（如 `repeated-edit-rejection`）。 */
  id: string;
  /**
   * 是否被采纳：
   * - `true`：本会话内观测到用户执行了该提示指向的动作（目前只有 `/review` 一类可观测）；
   * - `false`：提示消失前没有观测到对应动作；
   * - `null`：**无法观测**（例如提示指向的是另一个终端里的 `concertoai init`）——
   *   记为 null 而不是 false，否则「采纳率」会对用户说假话。
   */
  adopted: boolean | null;
}

/** 一次体检结果（只记计数，不记错误内容）。 */
export interface CheckMetric {
  ts: number;
  kind: 'check';
  ok: boolean;
  /** 通过段数。 */
  passed: number;
  /** 失败段数。 */
  failed: number;
}

/** 用到了哪个动词（一次命令一条）。 */
export interface VerbMetric {
  ts: number;
  kind: 'verb';
  verb: MetricsVerb;
}

/** 指标事件联合类型。 */
export type MetricsEvent = ApprovalMetric | SuggestionMetric | CheckMetric | VerbMetric;

// ── 常量 ──

/** 文件行数上限（超过即轮转）。 */
export const MAX_METRICS_ENTRIES = 1000;
/** 轮转后保留的条数（最近 N 条，保持趋势可比）。 */
export const KEEP_METRICS_ENTRIES = 500;
/** `doctor --metrics` 汇总使用的窗口（近 N 条）。 */
export const SUMMARY_WINDOW = 100;
/** 单条 `id` 字段长度上限（防手改文件/异常规则 id 把文件撑大）。 */
export const MAX_ID_LENGTH = 64;
/**
 * 审批事件的**字段清单**（隐私契约，写死在本文件）。
 *
 * 用途是「防悄悄多收集」：想往审批指标里加字段（例如文件路径），必须同时改这里，
 * 而 `tests/core/metrics-store.test.ts` 会报红——逼着人明确回答「这真的是必要的吗」。
 */
export const DEFAULT_METRICS_EXPECTATION: readonly string[] = [
  'ts',
  'kind',
  'durationMs',
  'decision',
  'level',
];

// ── 开关（双轨：环境变量 > config；默认 **off**）──

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
 * 指标开关（双轨：环境变量 > config；**默认 off**）。
 *
 * 与 `isReflectionsEnabled`（默认 on）刻意不同：指标是**我们**想看的，用户的默认
 * 不是「允许记录」。所以必须用户显式开启才写盘。
 *
 * **无法识别的值一律忽略、回落到下一层**（不是「按 on/off 猜」）：
 * `CONCERTOAI_METRICS=of` 这类手滑若按默认 off 处理没问题，但若用户在配置里显式开了
 * `on`，手滑值不该**静默推翻**它（与 T11/T12 同一套语义）。
 */
export function isMetricsEnabled(configValue?: string, envValue?: string): boolean {
  const fromEnv = parseSwitchValue(envValue);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const fromConfig = parseSwitchValue(configValue);
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  return false;
}

// ── 纯函数：构造事件 ──

/** 注入选项（测试用 tmp 目录/文件 + 可控时钟）。 */
export interface MetricsStoreOptions {
  /** 文件路径（缺省 `~/.concertoai/metrics.jsonl`）。 */
  file?: string;
  /** 时钟注入（缺省 `Date.now`）。 */
  now?: () => number;
  /** 行数上限（缺省 `MAX_METRICS_ENTRIES`）。 */
  maxEntries?: number;
  /** 轮转保留条数（缺省 `KEEP_METRICS_ENTRIES`）。 */
  keepEntries?: number;
}

/** 指标文件路径（单一来源：`store/paths.ts`）。 */
export function defaultMetricsPath(): string {
  return metricsPath();
}

/** 耗时归一化：非有限值 / 负值 → 0（宁可少算，不写 NaN 进文件）。 */
export function normalizeDuration(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value);
}

/** 构造审批事件（纯函数）。 */
export function buildApprovalMetric(input: {
  durationMs?: number;
  approved: boolean;
  level?: RiskLevel | null;
  now?: () => number;
}): ApprovalMetric {
  return {
    ts: (input.now ?? Date.now)(),
    kind: 'approval',
    durationMs: normalizeDuration(input.durationMs),
    decision: input.approved ? 'approved' : 'rejected',
    // 未分析 ≠ 低风险（D72 同一套价值观）
    level: input.level ?? 'unknown',
  };
}

/** 构造提示事件（纯函数；`id` 超长截断）。 */
export function buildSuggestionMetric(input: {
  id: string;
  adopted: boolean | null;
  now?: () => number;
}): SuggestionMetric {
  return {
    ts: (input.now ?? Date.now)(),
    kind: 'suggestion',
    id: input.id.slice(0, MAX_ID_LENGTH),
    adopted: input.adopted,
  };
}

/** 构造体检事件（纯函数；计数归一化为非负整数）。 */
export function buildCheckMetric(input: {
  ok: boolean;
  passed?: number;
  failed?: number;
  now?: () => number;
}): CheckMetric {
  return {
    ts: (input.now ?? Date.now)(),
    kind: 'check',
    ok: input.ok,
    passed: countOf(input.passed),
    failed: countOf(input.failed),
  };
}

/** 构造动词事件（纯函数）。 */
export function buildVerbMetric(input: { verb: MetricsVerb; now?: () => number }): VerbMetric {
  return { ts: (input.now ?? Date.now)(), kind: 'verb', verb: input.verb };
}

function countOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value);
}

// ── IO：追加 / 读取 / 清空 ──

/** 写入结果（调用方**不需要**处理失败——指标不是关键路径）。 */
export interface MetricsWriteResult {
  ok: boolean;
  /** 本次是否触发了轮转（诊断用）。 */
  rotated?: boolean;
  /** 失败原因（仅诊断，不面向普通用户）。 */
  error?: string;
}

/**
 * 追加一条指标（**永不抛错**）。
 *
 * 顺序：确保目录 → O_APPEND 追加 → 超上限则轮转。
 * 轮转失败**不回滚**已追加的行：宁可文件多一行，也不要为了「干净」把用户的数据弄丢。
 */
export async function appendMetric(
  event: MetricsEvent,
  options: MetricsStoreOptions = {},
): Promise<MetricsWriteResult> {
  const file = options.file ?? defaultMetricsPath();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
  try {
    const rotated = await rotateIfNeeded(file, options);
    return { ok: true, rotated };
  } catch (error) {
    // 轮转失败不影响「已经写进去了」这个事实
    return { ok: true, rotated: false, error: messageOf(error) };
  }
}

/** 行数超上限 → 保留最近 `keepEntries` 行（原子写）。 */
async function rotateIfNeeded(file: string, options: MetricsStoreOptions): Promise<boolean> {
  const maxEntries = options.maxEntries ?? MAX_METRICS_ENTRIES;
  const keepEntries = options.keepEntries ?? KEEP_METRICS_ENTRIES;
  if (maxEntries <= 0 || keepEntries < 0) {
    return false;
  }
  const content = await readFile(file, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim() !== '');
  if (lines.length <= maxEntries) {
    return false;
  }
  const kept = keepEntries === 0 ? [] : lines.slice(-keepEntries);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8');
  await rename(tmp, file);
  return true;
}

/** 读取结果。 */
export interface MetricsReadResult {
  /** 按写入顺序（**旧→新**，便于「近 N 条 = 尾部」）。 */
  entries: MetricsEvent[];
  /** 跳过的损坏行数（半行 / 手改 / 非 JSON / 字段不合法）。 */
  skipped: number;
}

/** 校验一行 JSON 是否为合法指标事件（不合法 → 视为损坏行跳过）。 */
function parseMetricLine(line: string): MetricsEvent | null {
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
  if (obj.kind === 'approval') {
    if (obj.decision !== 'approved' && obj.decision !== 'rejected') {
      return null;
    }
    if (typeof obj.durationMs !== 'number' || !Number.isFinite(obj.durationMs)) {
      return null;
    }
    const level = obj.level;
    if (level !== 'high' && level !== 'medium' && level !== 'low' && level !== 'unknown') {
      return null;
    }
    return {
      ts: obj.ts,
      kind: 'approval',
      durationMs: normalizeDuration(obj.durationMs),
      decision: obj.decision,
      level,
    };
  }
  if (obj.kind === 'suggestion') {
    if (typeof obj.id !== 'string') {
      return null;
    }
    const adopted = obj.adopted;
    if (adopted !== true && adopted !== false && adopted !== null) {
      return null;
    }
    return { ts: obj.ts, kind: 'suggestion', id: obj.id, adopted };
  }
  if (obj.kind === 'check') {
    if (typeof obj.ok !== 'boolean') {
      return null;
    }
    return {
      ts: obj.ts,
      kind: 'check',
      ok: obj.ok,
      passed: countOf(typeof obj.passed === 'number' ? obj.passed : 0),
      failed: countOf(typeof obj.failed === 'number' ? obj.failed : 0),
    };
  }
  if (obj.kind === 'verb') {
    const verb = obj.verb;
    if (verb !== 'check' && verb !== 'fix' && verb !== 'commit' && verb !== 'review') {
      return null;
    }
    return { ts: obj.ts, kind: 'verb', verb };
  }
  return null;
}

/**
 * 读取指标事件（**旧→新**）。
 *
 * - 文件不存在 → 空结果（首次运行不报错、不创建文件）；
 * - 损坏行 → 跳过并计数，**不中断读取**；
 * - `limit` 取**最近 N 条**（尾部），因为「现在的体验」比「三个月前」重要。
 */
export async function readMetrics(
  options: MetricsStoreOptions & { limit?: number } = {},
): Promise<MetricsReadResult> {
  const file = options.file ?? defaultMetricsPath();
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return { entries: [], skipped: 0 };
  }
  const entries: MetricsEvent[] = [];
  let skipped = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const event = parseMetricLine(trimmed);
    if (event === null) {
      skipped += 1;
      continue;
    }
    entries.push(event);
  }
  const limit = options.limit;
  const picked = limit !== undefined && limit > 0 ? entries.slice(-limit) : entries;
  return { entries: picked, skipped };
}

/**
 * 清空指标（**永不抛错**，幂等）。
 *
 * 文件本来就不存在 → `removed: false` 且 `ok: true`（重复清空不该报错）。
 */
export async function clearMetrics(
  options: MetricsStoreOptions = {},
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const file = options.file ?? defaultMetricsPath();
  try {
    await rm(file, { force: true });
    return { ok: true, removed: true };
  } catch (error) {
    return { ok: false, removed: false, error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 汇总（纯函数：喂固定样本即可断言数字） ──

/** 汇总结果（`doctor --metrics` 的渲染素材）。 */
export interface MetricsSummary {
  /** 有效事件总数。 */
  total: number;
  approval: {
    count: number;
    /** 平均耗时（毫秒，四舍五入）。 */
    avgMs: number;
    /** 中位耗时（毫秒；偶数个取中间两个的平均）。 */
    medianMs: number;
    rejected: number;
    /** 拒绝率（0-100，保留 1 位小数）；无数据 → null。 */
    rejectRate: number | null;
    /** 各等级分布（只统计出现过的）。 */
    levels: Partial<Record<RiskLevel | 'unknown', number>>;
  };
  suggestion: {
    count: number;
    adopted: number;
    /** 「有观测但没采纳」的条数。 */
    notAdopted: number;
    /** 无法观测的条数（`adopted === null`）。 */
    unobservable: number;
    /** 采纳率（0-100，保留 1 位小数）；无**可观测**样本 → null。 */
    adoptionRate: number | null;
  };
  check: {
    count: number;
    ok: number;
    /** 通过率（0-100，保留 1 位小数）；无数据 → null。 */
    passRate: number | null;
  };
  /** 动词使用分布（按次数降序；次数相同按名字升序保证稳定）。 */
  verbs: { verb: MetricsVerb; count: number }[];
}

/** 保留 1 位小数。 */
function rate1(part: number, whole: number): number | null {
  if (whole <= 0) {
    return null;
  }
  return Math.round((part / whole) * 1000) / 10;
}

/** 中位数（空数组 → 0）。 */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return Math.round(sorted[mid] as number);
  }
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * 汇总指标（纯函数，无 IO）。
 *
 * 调用方传入「要汇总的窗口」（`doctor --metrics` 传近 100 条），本函数不再做截断——
 * 窗口大小是一处决定，不在这里再猜一遍。
 */
export function summarizeMetrics(events: readonly MetricsEvent[]): MetricsSummary {
  const approvals = events.filter((e): e is ApprovalMetric => e.kind === 'approval');
  const suggestions = events.filter((e): e is SuggestionMetric => e.kind === 'suggestion');
  const checks = events.filter((e): e is CheckMetric => e.kind === 'check');
  const verbs = events.filter((e): e is VerbMetric => e.kind === 'verb');

  const durations = approvals.map((a) => a.durationMs);
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  const rejected = approvals.filter((a) => a.decision === 'rejected').length;

  const levels: Partial<Record<RiskLevel | 'unknown', number>> = {};
  for (const approval of approvals) {
    levels[approval.level] = (levels[approval.level] ?? 0) + 1;
  }

  const adopted = suggestions.filter((s) => s.adopted === true).length;
  const notAdopted = suggestions.filter((s) => s.adopted === false).length;
  const unobservable = suggestions.filter((s) => s.adopted === null).length;

  const verbCounts = new Map<MetricsVerb, number>();
  for (const event of verbs) {
    verbCounts.set(event.verb, (verbCounts.get(event.verb) ?? 0) + 1);
  }
  const verbList = [...verbCounts.entries()]
    .map(([verb, count]) => ({ verb, count }))
    .sort((a, b) => (b.count === a.count ? a.verb.localeCompare(b.verb) : b.count - a.count));

  return {
    total: events.length,
    approval: {
      count: approvals.length,
      avgMs: approvals.length === 0 ? 0 : Math.round(totalDuration / approvals.length),
      medianMs: median(durations),
      rejected,
      rejectRate: rate1(rejected, approvals.length),
      levels,
    },
    suggestion: {
      count: suggestions.length,
      adopted,
      notAdopted,
      unobservable,
      // 只拿「可观测」的当分母：把 unobservable 算成未采纳 = 对用户说假话
      adoptionRate: rate1(adopted, adopted + notAdopted),
    },
    check: {
      count: checks.length,
      ok: checks.filter((c) => c.ok).length,
      passRate: rate1(checks.filter((c) => c.ok).length, checks.length),
    },
    verbs: verbList,
  };
}
