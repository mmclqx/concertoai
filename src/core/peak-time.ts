/**
 * 高峰时段检测（v2.2 智能成本控制 / v5.0 T7 计价双档）。
 *
 * **两套口径，各自独立演进（v5.0 T7 拆分，R7）**：
 * - `SWITCH_PEAK_RANGES` + `isPeakTime()`  → **模型切换口径**（v2.2 起）：高峰时段是否切到本地 ollama；
 * - `PRICING_PEAK_RANGES` + `isPricingPeakTime()` → **计价口径**（v5.0 T7）：DeepSeek 高峰/空闲价档位。
 *
 * 为什么要拆：两者业务含义不同——「切不切本地模型」是产品干预策略，「按哪个价档计费」是厂商定价事实。
 * 若日后 DeepSeek 公布的高峰时段与我们的切换时段不同，只需改 `PRICING_PEAK_RANGES`，
 * 不会顺带改变用户的 ollama 切换行为（历史教训：耦合改动会静默破坏既有功能，见 AGENTS 规则 14）。
 *
 * 当前兜底：DeepSeek 官方**未公开**明确的高峰时段定义（v5.0 T7 未取得可核验的一手来源），
 * 两套口径暂时取相同值（工作日 9:00-12:00 / 14:00-18:00）。详见 ADR-038。
 *
 * 区间为左闭右开 [startHour, endHour)——12:00 整不属于高峰、18:00 整不属于高峰。
 * 纯函数、无副作用，`Date` 可注入以便测试。
 */

/** 高峰时段区间（左闭右开，小时制）。 */
export interface PeakRange {
  startHour: number;
  endHour: number;
}

/** 模型切换口径的高峰区间（v2.2 原有语义，切 ollama 用）。 */
export const SWITCH_PEAK_RANGES: readonly PeakRange[] = [
  { startHour: 9, endHour: 12 },
  { startHour: 14, endHour: 18 },
];

/**
 * 计价口径的高峰区间（v5.0 T7）。
 *
 * ⚠️ 目前与 `SWITCH_PEAK_RANGES` 同值，源于「官方未公开 → 兜底自定」；
 * 一旦取得官方定义，**只改这里**（并同步 ADR-038 + 价格档位测试）。
 */
export const PRICING_PEAK_RANGES: readonly PeakRange[] = [
  { startHour: 9, endHour: 12 },
  { startHour: 14, endHour: 18 },
];

/** 向后兼容别名（等于切换口径，历史调用方勿改语义）。 */
export const PEAK_TIME_RANGES: readonly PeakRange[] = SWITCH_PEAK_RANGES;

/** 判断是否为工作日（周一至周五）；date 缺省为当前时间。 */
export function isWorkday(date: Date = new Date()): boolean {
  const day = date.getDay(); // 0=周日 … 6=周六
  return day >= 1 && day <= 5;
}

/** 判断给定小时是否落在任一时段区间内（左闭右开）。 */
function hourInRanges(date: Date, ranges: readonly PeakRange[]): boolean {
  const hour = date.getHours();
  return ranges.some((r) => hour >= r.startHour && hour < r.endHour);
}

/** 判断当前小时是否位于高峰时段（9-12 或 14-18，左闭右开）；date 缺省为当前时间。 */
export function isPeakHour(date: Date = new Date()): boolean {
  return hourInRanges(date, SWITCH_PEAK_RANGES);
}

/** 判断当前是否处于高峰时段 = 工作日 且 高峰小时；date 缺省为当前时间。 */
export function isPeakTime(date: Date = new Date()): boolean {
  return isWorkday(date) && isPeakHour(date);
}

/**
 * 判断当前是否处于**计价**高峰时段（工作日 + `PRICING_PEAK_RANGES`）。
 *
 * v5.0 T7：供 `model/models.ts` 的 `priceTierFor` 使用；与 `isPeakTime`（切换口径）解耦。
 */
export function isPricingPeakTime(date: Date = new Date()): boolean {
  return isWorkday(date) && hourInRanges(date, PRICING_PEAK_RANGES);
}
