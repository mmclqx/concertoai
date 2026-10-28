/**
 * 指标 CLI 胶水层（v5.0 T21）。
 *
 * 这一层只做两件「需要知道配置和 i18n」的事：
 *
 * 1. **`recordVerbMetric`**：CLI 动词（`check` / `fix` / `commit` / `review`）跑完后记一条
 *    `verb` 事件。「开没开」由 `resolveConfig` 统一判定（与环境变量合并在同一处），
 *    本层不自己读 `process.env`——否则开关优先级会变成两套（T11 教训）。
 * 2. **`formatMetricsSummary`**：把纯函数 `summarizeMetrics` 的数字渲染成 `doctor --metrics`
 *    的用户可读行（文案全部来自 i18n，中文/英文同构）。
 *
 * 失败一律静默：指标是**可选便利功能**，写不进去不该让 `concertoai check` 报错。
 */

import {
  appendMetric,
  buildCheckMetric,
  buildVerbMetric,
  MAX_METRICS_ENTRIES,
  type MetricsEvent,
  type MetricsStoreOptions,
  type MetricsSummary,
  type MetricsVerb,
  type MetricsWriteResult,
  SUMMARY_WINDOW,
} from '../core/metrics-store';
import { fmt, t } from '../i18n';
import { loadConfig, resolveConfig } from '../store/config';

/** 记录动词事件的选项（全部可注入，便于单测不碰真实 home）。 */
export interface RecordVerbOptions {
  /** 直接指定开关状态（测试用）；缺省读配置 + 环境变量（`resolveConfig` 唯一来源）。 */
  enabled?: boolean;
  /** 指标文件路径（缺省 `~/.concertoai/metrics.jsonl`）。 */
  file?: string;
  /** 时钟注入。 */
  now?: () => number;
  /** 追加实现（缺省 `appendMetric`）。 */
  append?: (event: MetricsEvent, options?: MetricsStoreOptions) => Promise<MetricsWriteResult>;
}

/**
 * 解析「现在是否记录指标」：`resolveConfig` 是唯一来源（config + 环境变量合并）。
 *
 * 配置读不出来（文件损坏 / 无权限）→ 当作 off：**宁可少记，不可误记**。
 */
export async function resolveMetricsEnabled(): Promise<boolean> {
  try {
    const file = await loadConfig();
    return resolveConfig(file).metrics === 'on';
  } catch {
    return false;
  }
}

/**
 * 记一条「用了哪个动词」事件（**永不抛错**）。
 *
 * 关闭状态下**连文件都不碰**（有用例断言：默认 off 时不产生 metrics 文件）。
 */
export async function recordVerbMetric(
  verb: MetricsVerb,
  options: RecordVerbOptions = {},
): Promise<void> {
  try {
    const enabled = options.enabled ?? (await resolveMetricsEnabled());
    if (!enabled) {
      return;
    }
    const event = buildVerbMetric({
      verb,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const append = options.append ?? appendMetric;
    await append(event, options.file !== undefined ? { file: options.file } : {});
  } catch {
    // 指标不是关键路径：任何异常都不该影响用户正在做的事
  }
}

/** 记录体检事件的选项（同 `RecordVerbOptions`，可注入）。 */
export interface RecordCheckOptions extends RecordVerbOptions {}

/**
 * 记一条体检结果事件（**永不抛错**）。
 *
 * 只记「通过/失败段数」这类结构化数字，**不记错误内容、不记文件路径**——
 * 指标的用途是回答「提交前体检到底有多少次是能过的」，不是替用户备份报错。
 */
export async function recordCheckMetric(
  input: { ok: boolean; passed: number; failed: number },
  options: RecordCheckOptions = {},
): Promise<void> {
  try {
    const enabled = options.enabled ?? (await resolveMetricsEnabled());
    if (!enabled) {
      return;
    }
    const event = buildCheckMetric({
      ok: input.ok,
      passed: input.passed,
      failed: input.failed,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const append = options.append ?? appendMetric;
    await append(event, options.file !== undefined ? { file: options.file } : {});
  } catch {
    // 静默（同 recordVerbMetric）
  }
}

/** 汇总渲染的输入。 */
export interface MetricsSummaryInput {
  summary: MetricsSummary;
  /** 指标文件路径（回执里给用户看位置）。 */
  file: string;
  /** 当前开关状态（医生报告要说清「你没开，所以没数据」）。 */
  enabled: boolean;
  /** 读取时跳过的损坏行数。 */
  skipped: number;
}

/** 保留 1 位小数的百分比文案（`null` → 破折号，绝不写成 0%）。 */
function percent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/**
 * 渲染 `doctor --metrics` 汇总行（纯函数：给定样本即可逐字断言）。
 *
 * **诚实红线**：
 * - 没有数据 → 明确说「没有数据」并给出开启命令，绝不打印一堆 `0%` 冒充统计；
 * - 提示采纳率只拿**可观测**样本当分母，并如实报出「无法观测 N 条」；
 * - 动词分布为空 → 破折号，不写「暂无」以外的花哨措辞。
 */
export function formatMetricsSummary(input: MetricsSummaryInput): string[] {
  const dict = t().metrics;
  const { summary } = input;
  const lines: string[] = [];
  lines.push(`${dict.title}（近 ${SUMMARY_WINDOW} 条 ｜ 上限 ${MAX_METRICS_ENTRIES} 条）`);
  lines.push(`  ${input.enabled ? dict.enabled : dict.disabled}`);
  lines.push(`  ${fmt(dict.fileLine, { path: input.file })}`);
  if (input.skipped > 0) {
    lines.push(`  ${fmt(dict.skipped, { count: input.skipped })}`);
  }
  if (summary.total === 0) {
    lines.push(`  ${dict.empty}`);
    return lines;
  }
  if (summary.approval.count > 0) {
    lines.push(
      `  ${fmt(dict.approvalLine, {
        count: summary.approval.count,
        avg: summary.approval.avgMs,
        median: summary.approval.medianMs,
        rate: percent(summary.approval.rejectRate),
      })}`,
    );
  }
  if (summary.suggestion.count > 0) {
    const observed = summary.suggestion.adopted + summary.suggestion.notAdopted;
    if (observed === 0) {
      lines.push(`  ${fmt(dict.suggestionLineUnobservable, { count: summary.suggestion.count })}`);
    } else {
      lines.push(
        `  ${fmt(dict.suggestionLine, {
          count: summary.suggestion.count,
          observed,
          unobservable: summary.suggestion.unobservable,
          rate: percent(summary.suggestion.adoptionRate),
        })}`,
      );
    }
  }
  if (summary.check.count > 0) {
    lines.push(
      `  ${fmt(dict.checkLine, {
        count: summary.check.count,
        rate: percent(summary.check.passRate),
      })}`,
    );
  }
  const verbText =
    summary.verbs.length === 0
      ? dict.noVerbs
      : summary.verbs.map((item) => `${item.verb}×${item.count}`).join(' ｜ ');
  lines.push(`  ${fmt(dict.verbLine, { list: verbText })}`);
  return lines;
}
