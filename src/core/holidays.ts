/**
 * 中国法定节假日日历（v5.0 T7 修订：计价高峰必须排除法定节假日与纳入调休上班日）。
 *
 * ## 为什么需要这个模块
 *
 * 「工作日 9:00-12:00 / 14:00-18:00 为高峰价」这个规则单独用会算错两类日子：
 * 1. **法定节假日**（如国庆 10/1-10/7）本身是休市日 → 不该按高峰价计费；
 * 2. **调休上班日**（国务院安排里某些周六/周日需上班）→ 反而**应该**按高峰价计费。
 * 因此计价口径的工作日判定必须是「(周一~周五 且 非法定节假日) 或 调休上班日」。
 *
 * ## ⚠️ 内置数据为什么是空的（如实声明，勿当已核验数据）
 *
 * 节假日安排每年由**国务院办公厅**发布《关于〈年〉年部分节假日安排的通知》，逐年变化，
 * 且必须同时包含「放假日期」与「调休上班日期」两张表——**猜错一天 = 计价档位错一天**（直接算错钱）。
 *
 * 本轮开发无联网核验能力，**因此不内置任何凭记忆推测的日期**（AGENTS 规则：禁止编造）。
 * 正确用法有两条：
 * - **运行时配置**（推荐，无需改代码）：`~/.concertoai/config.json` 写
 *   `pricingHolidays: { holidays: ['2027-01-01', …], makeupWorkdays: ['2027-02-20', …] }`，
 *   启动时由 `configureHolidayCalendar` 装载；
 * - **内置兜底**：把核对过的日期写进 `BUILTIN_HOLIDAY_CALENDAR`（仅当版本发布时想带数据）。
 *
 * 未配置时**不会静默犯错**：`holidayCalendarStatus().configured === false`，
 * `concertoai balance` 会显式提示「未配置节假日表：法定节假日/调休日可能仍按工作日计价」。
 *
 * ## 配置装载为什么用模块级状态
 *
 * `isPricingPeakTime` 被 `priceTierFor → costFor → costForProvider → Provider.cost → StatusBar/App/balance`
 * 一条长链调用。给整条链加 `calendar` 参数会让「纯粹的时间判定」污染 8+ 个签名（且每处都可能传错）。
 * 因此把节假日表作为**进程级配置**装载一次，保持判定函数签名不变；
 * 测试用 `resetHolidayCalendar()` 显式复位，不依赖调用顺序。
 *
 * 纯数据 + 纯判定，无 IO、无网络；日期一律按**本地时区**的 YYYY-MM-DD 比较。
 */

/** 节假日日历输入（config.pricingHolidays 同构）。 */
export interface HolidayCalendarInput {
  /** 法定节假日日期（`YYYY-MM-DD`，本地时区）→ 当天按非工作日计价。 */
  holidays?: string[];
  /** 调休上班日（`YYYY-MM-DD`，通常是周六/周日但要上班）→ 当天按工作日计价。 */
  makeupWorkdays?: string[];
}

/** 配置装载结果（便于 doctor / 启动日志如实反馈，不静默丢弃非法值）。 */
export interface HolidayCalendarReport {
  /** 已生效的节假日天数。 */
  holidayCount: number;
  /** 已生效的调休上班日天数。 */
  makeupCount: number;
  /** 非法日期（格式错误 / 不存在的日期），已忽略并原样回传供提示。 */
  invalid: string[];
  /** 是否已配置（false = 空表，计价不排除节假日）。 */
  configured: boolean;
}

/**
 * 内置节假日表（**默认空**，见文件头「为什么不内置推测数据」）。
 *
 * 若未来要随版本发布带数据，格式如下（务必与国务院办公厅通知逐条核对）：
 * ```ts
 * export const BUILTIN_HOLIDAY_CALENDAR: HolidayCalendarInput = {
 *   holidays: ['2027-01-01', '2027-02-06', …],
 *   makeupWorkdays: ['2027-02-20', …],
 * };
 * ```
 */
export const BUILTIN_HOLIDAY_CALENDAR: HolidayCalendarInput = {};

/** 生效中的节假日集合（模块级配置，见文件头说明）。 */
let activeHolidays: ReadonlySet<string> = new Set();
let activeMakeupWorkdays: ReadonlySet<string> = new Set();
let activeConfigured = false;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 日期 → `YYYY-MM-DD`（**本地时区**，不用 `toISOString`——那是 UTC，跨时区会把日期算错一天）。
 */
export function localDateKey(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 校验 `YYYY-MM-DD` 是否是真实存在的日期（拦掉 2027-02-30 这类）。 */
export function isValidDateKey(key: string): boolean {
  if (!DATE_KEY_PATTERN.test(key)) {
    return false;
  }
  const [yearText, monthText, dayText] = key.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  // 构造本地日期后回读三个字段：不一致说明该日不存在（如 2 月 30 日会被进到 3 月）
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}

/**
 * 装载节假日日历（覆盖式：每次调用都先清空旧值，避免测试/多次调用残留）。
 *
 * 非法日期**不静默丢弃**：收集进 `invalid` 由调用方提示（用户改配置打错字必须看得见）。
 */
export function configureHolidayCalendar(
  input: HolidayCalendarInput | undefined,
): HolidayCalendarReport {
  const holidays = new Set<string>();
  const makeupWorkdays = new Set<string>();
  const invalid: string[] = [];

  const absorb = (values: readonly string[] | undefined, sink: Set<string>): void => {
    for (const raw of values ?? []) {
      const key = raw.trim();
      if (isValidDateKey(key)) {
        sink.add(key);
      } else {
        invalid.push(raw);
      }
    }
  };

  absorb(input?.holidays, holidays);
  absorb(input?.makeupWorkdays, makeupWorkdays);
  activeHolidays = holidays;
  activeMakeupWorkdays = makeupWorkdays;
  activeConfigured = holidays.size > 0 || makeupWorkdays.size > 0;

  return {
    holidayCount: holidays.size,
    makeupCount: makeupWorkdays.size,
    invalid,
    configured: activeConfigured,
  };
}

/** 复位为「未配置」（测试隔离用；也让运行时可显式关闭节假日排除）。 */
export function resetHolidayCalendar(): void {
  activeHolidays = new Set();
  activeMakeupWorkdays = new Set();
  activeConfigured = false;
}

/** 当前日历状态（`configured === false` 时调用方应提示「未排除节假日」）。 */
export function holidayCalendarStatus(): HolidayCalendarReport {
  return {
    holidayCount: activeHolidays.size,
    makeupCount: activeMakeupWorkdays.size,
    invalid: [],
    configured: activeConfigured,
  };
}

/** 是否为法定节假日（未配置表时恒为 false——不猜）。 */
export function isCnStatutoryHoliday(at: Date): boolean {
  return activeHolidays.has(localDateKey(at));
}

/** 是否为调休上班日（周末补班，未配置表时恒为 false）。 */
export function isCnMakeupWorkday(at: Date): boolean {
  return activeMakeupWorkdays.has(localDateKey(at));
}
