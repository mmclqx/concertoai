import { describe, expect, it } from 'vitest';

import { isPeakHour, isPeakTime, isWorkday, PEAK_TIME_RANGES } from '../../src/core/peak-time';

/** 构造指定周几与小时的 Date（星期天=0 … 星期六=6）。 */
function at(dayOfWeek: number, hour: number, minute = 0): Date {
  // 用固定基准日（2026-08-03 是周一）推算
  const base = new Date(2026, 7, 3, hour, minute); // 2026-08-03 = 周一
  return new Date(base.getTime() + (dayOfWeek - 1) * 86_400_000);
}

describe('isWorkday', () => {
  it('周一至周五为工作日', () => {
    for (let day = 1; day <= 5; day += 1) {
      expect(isWorkday(at(day, 10))).toBe(true);
    }
  });

  it('周六/周日不是工作日', () => {
    expect(isWorkday(at(0, 10))).toBe(false);
    expect(isWorkday(at(6, 10))).toBe(false);
  });
});

describe('isPeakHour', () => {
  it('9:00-12:00 与 14:00-18:00 为高峰小时（左闭右开）', () => {
    expect(isPeakHour(at(1, 9))).toBe(true);
    expect(isPeakHour(at(1, 11, 59))).toBe(true);
    expect(isPeakHour(at(1, 12))).toBe(false); // 12:00 整不属于
    expect(isPeakHour(at(1, 13, 59))).toBe(false);
    expect(isPeakHour(at(1, 14))).toBe(true);
    expect(isPeakHour(at(1, 17, 59))).toBe(true);
    expect(isPeakHour(at(1, 18))).toBe(false); // 18:00 整不属于
  });

  it('非高峰小时（8:00 / 13:00 / 20:00）返回 false', () => {
    expect(isPeakHour(at(1, 8))).toBe(false);
    expect(isPeakHour(at(1, 13))).toBe(false);
    expect(isPeakHour(at(1, 20))).toBe(false);
  });

  it('高峰区间定义为 9-12 与 14-18 两段', () => {
    expect(PEAK_TIME_RANGES).toEqual([
      { startHour: 9, endHour: 12 },
      { startHour: 14, endHour: 18 },
    ]);
  });
});

describe('isPeakTime', () => {
  it('工作日 + 高峰小时 = 高峰时段', () => {
    expect(isPeakTime(at(1, 10))).toBe(true); // 周一 10:00
    expect(isPeakTime(at(5, 15))).toBe(true); // 周五 15:00
  });

  it('周末或非高峰小时都不是高峰时段', () => {
    expect(isPeakTime(at(0, 10))).toBe(false); // 周日 10:00
    expect(isPeakTime(at(6, 15))).toBe(false); // 周六 15:00
    expect(isPeakTime(at(1, 8))).toBe(false); // 周一 8:00
    expect(isPeakTime(at(3, 13))).toBe(false); // 周三 13:00
    expect(isPeakTime(at(3, 19))).toBe(false); // 周三 19:00
  });

  it('缺省参数使用当前时间（不抛错）', () => {
    expect(typeof isPeakTime()).toBe('boolean');
    expect(typeof isWorkday()).toBe('boolean');
    expect(typeof isPeakHour()).toBe('boolean');
  });
});
