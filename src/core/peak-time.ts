/**
 * 高峰时段检测（v2.2 智能成本控制）。
 *
 * 定义：工作日（周一至周五）且位于高峰时段（9:00-12:00 或 14:00-18:00）。
 * 区间为左闭右开 [startHour, endHour)——12:00 整不属于高峰、18:00 整不属于高峰。
 *
 * 纯函数、无副作用，`Date` 可注入以便测试。
 */

/** 高峰时段区间（左闭右开，小时制）。 */
export const PEAK_TIME_RANGES: readonly { startHour: number; endHour: number }[] = [
  { startHour: 9, endHour: 12 },
  { startHour: 14, endHour: 18 },
];

/** 判断是否为工作日（周一至周五）；date 缺省为当前时间。 */
export function isWorkday(date: Date = new Date()): boolean {
  const day = date.getDay(); // 0=周日 … 6=周六
  return day >= 1 && day <= 5;
}

/** 判断当前小时是否位于高峰时段（9-12 或 14-18，左闭右开）；date 缺省为当前时间。 */
export function isPeakHour(date: Date = new Date()): boolean {
  const hour = date.getHours();
  return PEAK_TIME_RANGES.some((r) => hour >= r.startHour && hour < r.endHour);
}

/** 判断当前是否处于高峰时段 = 工作日 且 高峰小时；date 缺省为当前时间。 */
export function isPeakTime(date: Date = new Date()): boolean {
  return isWorkday(date) && isPeakHour(date);
}
