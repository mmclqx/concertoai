/**
 * `concertoai reflect list / clear`（v5.0 T10）。
 *
 * | 子命令 | 行为 |
 * |---|---|
 * | `reflect list [--limit N]` | 按时间**倒序**表格展示（时间 / 级别 / 文件 / 风险类别），缺省 20 条 |
 * | `reflect clear [--yes]` | 确认后清空；非交互环境需 `--yes`（fail-closed，防误删） |
 *
 * ## 为什么 clear 要 fail-closed
 *
 * 复盘是「不可再生的判断历史」——被 AI 或脚本在管道里无声清空，用户就永久失去了
 * 「上次我为什么拒绝这个改动」的线索。所以非 TTY 且没有 `--yes` 时**直接拒绝**，
 * 而不是「读不到输入就当默认同意」（与全项目审批 fail-closed 同一套价值观）。
 *
 * ## 零网络
 *
 * 只读本地 JSONL，不 import `http`/`net`/`fetch`（护栏测试扫源码）。
 */

import {
  clearReflections,
  defaultReflectionsPath,
  type ReflectionEntry,
  readReflections,
} from '../core/reflection-store';
import { fmt, t } from '../i18n';
import { displayWidth, truncateToWidth } from '../utils/text-width';
import { promptLine } from './prompt';

/** 默认展示条数。 */
export const DEFAULT_REFLECT_LIMIT = 20;

/** 单列显示宽度上限。 */
const FILE_COL_WIDTH = 28;
const CATEGORY_COL_WIDTH = 26;

export interface RunReflectCommandOptions {
  /** 子命令（list / clear）。 */
  action: string;
  /** 展示条数（list）。 */
  limit?: number;
  /** 是否跳过确认（clear）。 */
  yes?: boolean;
  /** 文件路径注入（测试用）。 */
  file?: string;
  /** 确认回调注入（测试用；缺省走 TTY 行输入）。 */
  confirm?: (question: string) => Promise<boolean>;
  /** 输出注入（测试用；缺省 console.log）。 */
  log?: (message: string) => void;
}

/**
 * 按**显示宽度**补空格/截断到指定列宽（中文/emoji 占 2 格，不能用 `.length`）。
 *
 * 导出为纯函数是为了能直接断言「列宽是否真的对齐」——表格对齐的正确性靠
 * 截取整行来验证是验不出来的（按字符下标切 ≠ 按显示列切，测试自己就会先算错）。
 */
export function padToDisplayWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  const missing = width - displayWidth(clipped);
  return missing > 0 ? `${clipped}${' '.repeat(missing)}` : clipped;
}

/** 时间戳 → 本地 `MM-DD HH:mm`（表格里不需要年份，宽度有限）。 */
export function formatReflectionTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 等级 → 表格里的短标签（`unknown` 如实写「未分析」，不冒充低风险）。 */
export function levelLabel(level: ReflectionEntry['level']): string {
  const dict = t().reflect;
  switch (level) {
    case 'high':
      return dict.levelHigh;
    case 'medium':
      return dict.levelMedium;
    case 'low':
      return dict.levelLow;
    default:
      return dict.levelUnknown;
  }
}

/** 格式化为表格行（表头 + 每行，纯函数便于单测）。 */
export function formatReflectionTable(entries: readonly ReflectionEntry[]): string[] {
  const dict = t().reflect;
  const header = `${padToDisplayWidth(dict.colTime, 12)} ${padToDisplayWidth(dict.colLevel, 10)} ${padToDisplayWidth(
    dict.colFile,
    FILE_COL_WIDTH,
  )} ${dict.colCategories}`;
  const rows = entries.map((entry) => {
    const categories =
      entry.categories.length > 0 ? entry.categories.join('、') : dict.noCategories;
    return `${padToDisplayWidth(formatReflectionTime(entry.ts), 12)} ${padToDisplayWidth(levelLabel(entry.level), 10)} ${padToDisplayWidth(
      entry.file === '' ? dict.noFile : entry.file,
      FILE_COL_WIDTH,
    )} ${truncateToWidth(categories, CATEGORY_COL_WIDTH)}`;
  });
  return [header, ...rows];
}

/** 解析 `--limit`：非正整数 → 缺省值（并如实提示，不静默吞掉用户的输入错误）。 */
export function parseReflectLimit(raw: string | undefined): { limit: number; invalid: boolean } {
  if (raw === undefined || raw.trim() === '') {
    return { limit: DEFAULT_REFLECT_LIMIT, invalid: false };
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    return { limit: DEFAULT_REFLECT_LIMIT, invalid: true };
  }
  return { limit: value, invalid: false };
}

/**
 * 执行 reflect 命令。
 * @returns 退出码（0 成功；1 参数错误 / 用户未确认 / 清空失败）
 */
export async function runReflectCommand(options: RunReflectCommandOptions): Promise<number> {
  const dict = t().reflect;
  const log = options.log ?? ((message: string): void => console.log(message));
  const file = options.file ?? defaultReflectionsPath();

  if (options.action === 'list') {
    const { entries, skipped } = await readReflections({
      file,
      limit: options.limit ?? DEFAULT_REFLECT_LIMIT,
    });
    if (entries.length === 0) {
      log(dict.listEmpty);
      if (skipped > 0) {
        log(fmt(dict.listSkipped, { count: skipped }));
      }
      return 0;
    }
    log(fmt(dict.listTitle, { count: entries.length }));
    for (const line of formatReflectionTable(entries)) {
      log(line);
    }
    if (skipped > 0) {
      log(fmt(dict.listSkipped, { count: skipped }));
    }
    log(dict.listHint);
    return 0;
  }

  if (options.action === 'clear') {
    const existing = await readReflections({ file });
    if (existing.entries.length === 0 && existing.skipped === 0) {
      log(dict.clearEmpty);
      return 0;
    }
    let confirmed = options.yes === true;
    if (!confirmed) {
      if (options.confirm !== undefined) {
        confirmed = await options.confirm(dict.clearConfirm);
      } else if (process.stdin.isTTY) {
        const answer = await promptLine(dict.clearConfirm);
        confirmed = answer !== undefined && /^(y|yes)$/i.test(answer.trim());
      } else {
        // 非交互 + 没有 --yes → 直接拒绝（见文件头「为什么 clear 要 fail-closed」）
        log(dict.clearNeedsYes);
        return 1;
      }
    }
    if (!confirmed) {
      log(dict.clearCanceled);
      return 0;
    }
    const result = await clearReflections({ file });
    if (!result.ok) {
      log(fmt(dict.clearFailed, { message: result.error ?? 'unknown' }));
      return 1;
    }
    log(fmt(dict.cleared, { path: file }));
    return 0;
  }

  log(fmt(dict.unknownAction, { action: options.action }));
  return 1;
}
