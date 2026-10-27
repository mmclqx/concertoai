/**
 * 法定节假日日历测试（v5.0 T7 修订：计价高峰排除节假日 + 纳入调休上班日）。
 *
 * 重点：
 * 1. **未配置时绝不猜**（返回 false + `configured: false`，由 `balance` 显式提示）；
 * 2. 非法日期**不静默丢弃**（进 `invalid`），也不生效；
 * 3. 计价口径 = 「(周一~周五 且 非法定节假日) 或 调休上班日」；
 * 4. 与切换口径的**有意差异**用测试锁定（节假日切换口径仍按 v2.2）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_HOLIDAY_CALENDAR,
  configureHolidayCalendar,
  holidayCalendarStatus,
  isCnMakeupWorkday,
  isCnStatutoryHoliday,
  isValidDateKey,
  localDateKey,
  resetHolidayCalendar,
} from '../../src/core/holidays';
import { isPeakTime, isPricingPeakTime, isPricingWorkday } from '../../src/core/peak-time';

/** 2026-10-26 周一 10:00（工作日高峰）。 */
const MONDAY_PEAK = new Date(2026, 9, 26, 10, 0, 0);
/** 2026-10-31 周六 10:00（周末）。 */
const SATURDAY_PEAK = new Date(2026, 9, 31, 10, 0, 0);

afterEach(() => {
  resetHolidayCalendar();
});

describe('内置表为空（如实声明：不编造放假日期）', () => {
  it('BUILTIN_HOLIDAY_CALENDAR 没有推测数据', () => {
    expect(BUILTIN_HOLIDAY_CALENDAR.holidays ?? []).toHaveLength(0);
    expect(BUILTIN_HOLIDAY_CALENDAR.makeupWorkdays ?? []).toHaveLength(0);
  });

  it('未配置时判定恒为 false（不猜），状态如实报告 configured=false', () => {
    expect(isCnStatutoryHoliday(MONDAY_PEAK)).toBe(false);
    expect(isCnMakeupWorkday(SATURDAY_PEAK)).toBe(false);
    expect(holidayCalendarStatus()).toMatchObject({ configured: false, holidayCount: 0 });
  });
});

describe('localDateKey / isValidDateKey', () => {
  it('localDateKey 用本地时区补零（不用 UTC，避免跨时区差一天）', () => {
    expect(localDateKey(new Date(2027, 0, 1, 0, 30))).toBe('2027-01-01');
    expect(localDateKey(new Date(2027, 11, 31, 23, 59))).toBe('2027-12-31');
  });

  it('isValidDateKey：格式正确且日期真实才通过', () => {
    expect(isValidDateKey('2027-01-01')).toBe(true);
    expect(isValidDateKey('2027-02-30')).toBe(false); // 2 月没有 30 日
    expect(isValidDateKey('2027-13-01')).toBe(false); // 没有 13 月
    expect(isValidDateKey('2027-1-1')).toBe(false); // 未补零
    expect(isValidDateKey('2027/01/01')).toBe(false);
    expect(isValidDateKey('abc')).toBe(false);
  });
});

describe('configureHolidayCalendar', () => {
  it('装载节假日与调休上班日（含空白容错）', () => {
    const report = configureHolidayCalendar({
      holidays: [' 2026-10-26 ', '2026-12-25'],
      makeupWorkdays: ['2026-10-31'],
    });
    expect(report).toMatchObject({
      holidayCount: 2,
      makeupCount: 1,
      invalid: [],
      configured: true,
    });
    expect(isCnStatutoryHoliday(MONDAY_PEAK)).toBe(true);
    expect(isCnMakeupWorkday(SATURDAY_PEAK)).toBe(true);
  });

  it('非法日期进 invalid 且**不生效**（用户打错字必须看得见）', () => {
    const report = configureHolidayCalendar({
      holidays: ['2026-02-30', 'not-a-date', '2026-10-26'],
    });
    expect(report.invalid).toEqual(['2026-02-30', 'not-a-date']);
    expect(report.holidayCount).toBe(1);
    expect(isCnStatutoryHoliday(MONDAY_PEAK)).toBe(true);
  });

  it('覆盖式装载（第二次调用清空第一次，避免残留）', () => {
    configureHolidayCalendar({ holidays: ['2026-10-26'] });
    const report = configureHolidayCalendar({ holidays: ['2026-12-25'] });
    expect(report.holidayCount).toBe(1);
    expect(isCnStatutoryHoliday(MONDAY_PEAK)).toBe(false); // 旧值已清
    expect(isCnStatutoryHoliday(new Date(2026, 11, 25, 10, 0))).toBe(true);
  });

  it('传 undefined → 复位为未配置（也让运行时可显式关闭排除）', () => {
    configureHolidayCalendar({ holidays: ['2026-10-26'] });
    const report = configureHolidayCalendar(undefined);
    expect(report.configured).toBe(false);
    expect(holidayCalendarStatus().configured).toBe(false);
  });
});

describe('isPricingWorkday：节假日排除 + 调休纳入', () => {
  it('普通工作日 → true；普通周末 → false（基线行为不变）', () => {
    expect(isPricingWorkday(MONDAY_PEAK)).toBe(true);
    expect(isPricingWorkday(SATURDAY_PEAK)).toBe(false);
  });

  it('法定节假日落在周一 → 不算计价工作日', () => {
    configureHolidayCalendar({ holidays: ['2026-10-26'] });
    expect(isPricingWorkday(MONDAY_PEAK)).toBe(false);
  });

  it('调休上班日落在周六 → **算**计价工作日（否则少收/多收都算错钱）', () => {
    configureHolidayCalendar({ makeupWorkdays: ['2026-10-31'] });
    expect(isPricingWorkday(SATURDAY_PEAK)).toBe(true);
  });

  it('节假日优先级高于调休上班日（同一天两者都有 → 按节假日算）', () => {
    configureHolidayCalendar({
      holidays: ['2026-10-26'],
      makeupWorkdays: ['2026-10-26'],
    });
    expect(isPricingWorkday(MONDAY_PEAK)).toBe(false);
  });
});

describe('isPricingPeakTime：节假日按空闲价', () => {
  it('节假日高峰时段 → 不算计价高峰（走空闲价）', () => {
    configureHolidayCalendar({ holidays: ['2026-10-26'] });
    expect(isPricingPeakTime(MONDAY_PEAK)).toBe(false);
    // 对照：同一天非节假日就应命中午高峰（确认不是整体失效）
    resetHolidayCalendar();
    expect(isPricingPeakTime(MONDAY_PEAK)).toBe(true);
  });

  it('调休上班日高峰时段 → 命中计价高峰', () => {
    configureHolidayCalendar({ makeupWorkdays: ['2026-10-31'] });
    expect(isPricingPeakTime(SATURDAY_PEAK)).toBe(true);
  });

  it('节假日非高峰时段仍为空闲（不因排除逻辑变成高峰）', () => {
    configureHolidayCalendar({ holidays: ['2026-10-26'] });
    expect(isPricingPeakTime(new Date(2026, 9, 26, 20, 0))).toBe(false);
  });
});

describe('与切换口径（isPeakTime）的有意差异（ADR-038）', () => {
  it('节假日：计价口径不算高峰，切换口径仍按 v2.2 算高峰（不改用户已配置的策略行为）', () => {
    configureHolidayCalendar({ holidays: ['2026-10-26'] });
    expect(isPricingPeakTime(MONDAY_PEAK)).toBe(false);
    expect(isPeakTime(MONDAY_PEAK)).toBe(true);
  });

  it('调休上班日：计价口径算高峰，切换口径仍按 v2.2 不算（同上，行为已锁定为有意差异）', () => {
    configureHolidayCalendar({ makeupWorkdays: ['2026-10-31'] });
    expect(isPricingPeakTime(SATURDAY_PEAK)).toBe(true);
    expect(isPeakTime(SATURDAY_PEAK)).toBe(false);
  });
});
