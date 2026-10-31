/**
 * 成本回执行（K15）：把 `UsageTotals` 渲染成**一行**人可读、脚本可解析的回执。
 *
 * 三个花钱动词（`review` / `commit` / `fix`）共用这一份格式化，避免三处各写一遍
 * 造成「同一份数据三种说法」（v5.0 反复踩过的坑：同一事实两处解析就会说法不一致）。
 *
 * ## 三种情况必须说三种话（这是本模块唯一的复杂度）
 *
 * | 情况 | 判据 | 输出 |
 * |---|---|---|
 * | 量到了、全可计价 | `measured && priced` | 调用次数 + token + ≈¥金额 |
 * | 量到了、含未定价模型 | `measured && !priced` | token + 金额（注明只是可计价部分） |
 * | 量不到 | `!measured` 或 `undefined` | 「未能统计，费用未知」——**绝不打印 ¥0** |
 *
 * ## 金额精度
 *
 * 余额接口只有 2 位小数（¥0.00 起），小额调用完全看不见；这里用 6 位小数兜住
 * 「一次子代理调用 ≈ ¥0.0003」这种量级，阈值判定才有意义。
 */

import { type Dict, fmt } from '../i18n';
import type { UsageTotals } from '../model/usage-tally';

/** 金额格式化：≥ ¥0.01 保留 4 位，更小的保留 6 位（不让小额显示成 0.0000）。 */
export function formatCny(cost: number): string {
  const value = Number.isFinite(cost) && cost > 0 ? cost : 0;
  return value >= 0.01 ? value.toFixed(4) : value.toFixed(6);
}

/**
 * 渲染成本回执行。
 *
 * @param totals 客户端上报的累计用量（`undefined` = 客户端不上报 usage）
 * @param dict 当前语言的 `usage` 文案段
 */
export function formatUsageLine(totals: UsageTotals | undefined, dict: Dict['usage']): string {
  if (totals === undefined || !totals.measured) {
    return dict.unmeasured;
  }
  const cost = formatCny(totals.cost);
  if (!totals.priced) {
    return fmt(dict.unpriced, {
      calls: totals.calls,
      input: totals.input,
      output: totals.output,
      cost,
      models: totals.unknownModels.join(', '),
    });
  }
  return fmt(dict.line, {
    calls: totals.calls,
    input: totals.input,
    output: totals.output,
    cacheHit: totals.cacheHit,
    cost,
  });
}
