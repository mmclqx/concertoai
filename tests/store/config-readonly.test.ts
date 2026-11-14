/**
 * `loadConfigReadOnly` / `readConfigFile({ migrate: false })` 的单元测试（v5.3 N1，任务书 T1.1）。
 *
 * ## 这一层为什么要单独测（不能只靠 doctor 的端到端用例）
 *
 * 端到端只看「config.json 的 sha 变没变」，它答不出**是哪一条途径让文件没变**：
 *   - 迁移被挡住（正确）；
 *   - 或者压根没读到 v3 配置（探针空转，也是「没变」）。
 * 所以这里逐条钉两件事：① **v3 字段真的被读进来了**（正例：`defaultModel` 能读到）；
 * ② **文件真的没被改写**（`sha256` 不变 + 无 `config.v3.bak`）。
 *
 * ## 正例自证（否则「不写盘」恒真）
 *
 * 「只读不写」这类否定断言有个天然陷阱：**实现整个坏掉（比如什么都不读）也满足它**。
 * 故每个「不」都配一个「该写的时候真的写」：
 *   - `loadConfig`（默认）读同一个 v3 文件 ⇒ **必须迁移**（文件变 v4 + 生成 .v3.bak）；
 *   - `loadConfig`（默认）⇒ **必须装载节假日日历**（`holidayCalendarStatus().configured === true`）。
 * 这两条一起构成「只读 ≠ 把迁移功能全局关掉」的证据（任务书 T1.3 用例 5）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { holidayCalendarStatus, resetHolidayCalendar } from '../../src/core/holidays';
import { loadConfig, loadConfigReadOnly } from '../../src/store/config';

let tmp: string;

/** v3 形态配置：含 `defaultModel`（v3 独有）+ `pricingHolidays`（用于验证日历装载副作用）。 */
const V3_CONFIG = {
  schemaVersion: 1,
  defaultModel: 'deepseek-chat',
  defaultProvider: undefined,
  locale: 'zh',
  pricingHolidays: { holidays: ['2026-01-01'] },
};

/** 每个用例一份独立文件（迁移会改写文件，共用会串味）。 */
function writeV3(name: string): string {
  const file = path.join(tmp, name);
  writeFileSync(file, `${JSON.stringify(V3_CONFIG, null, 2)}\n`, 'utf8');
  return file;
}

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-readonly-'));
  vi.stubEnv('LANG', '');
  vi.stubEnv('LUMEN_LOCALE', '');
  // 节假日日历是模块级状态：先复位，否则上一个文件的装载会污染本文件
  resetHolidayCalendar();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetHolidayCalendar();
});

describe('loadConfigReadOnly：不迁移（v3 配置原地不动）', () => {
  it('v3 配置 ⇒ 文件不被改写、不生成 `config.v3.bak`（且**确实读到了** v3 字段）', async () => {
    const file = writeV3('config-v3.json');
    const before = sha256(file);

    const config = await loadConfigReadOnly(file);

    // ① 正例：v3 字段真的读进来了（否则「没写盘」可能只是「没读到」）
    expect((config as unknown as { defaultModel?: string }).defaultModel).toBe('deepseek-chat');
    // ② 否定面：文件字节不变、没有备份
    expect(sha256(file)).toBe(before);
    expect(existsSync(`${file}.v3.bak`)).toBe(false);
    // ③ 记录外形的兼容形态：与「迁移失败」分支同形（schemaVersion 标成当前版本）
    expect(config.schemaVersion).toBe(1);
  });

  it('`loadConfig(file, { migrate: false })` 与 `loadConfigReadOnly` 行为一致（同一事实只有一处真相）', async () => {
    const a = writeV3('a.json');
    const b = writeV3('b.json');
    const configA = await loadConfigReadOnly(a);
    const configB = await loadConfig(b, { migrate: false });
    expect(configB).toEqual(configA);
    expect(sha256(a)).toBe(sha256(b));
    expect(existsSync(`${a}.v3.bak`)).toBe(false);
    expect(existsSync(`${b}.v3.bak`)).toBe(false);
  });

  it('v4 配置 ⇒ 照常读出（只读分支不影响已迁移用户）', async () => {
    const file = path.join(tmp, 'config-v4.json');
    writeFileSync(
      file,
      `${JSON.stringify({ schemaVersion: 2, defaultProvider: 'deepseek', legacy: { locale: 'en' } })}\n`,
      'utf8',
    );
    const config = await loadConfigReadOnly(file);
    expect(config.schemaVersion).toBe(2);
    // 迁移遗留字段仍被摊平（与默认版同一路径）
    expect((config as unknown as { locale?: string }).locale).toBe('en');
  });
});

describe('正例自证：默认 loadConfig 仍然迁移（只读没把功能全局关掉）', () => {
  it('`loadConfig`（默认 opts）读同一份 v3 ⇒ 文件被改写 + 生成 `config.v3.bak`', async () => {
    const file = writeV3('migrate-me.json');
    const before = sha256(file);

    await loadConfig(file);

    // 这条是「只读」类断言的对照面：若有人把只读做成「默认不迁移」，本用例红
    expect(existsSync(`${file}.v3.bak`)).toBe(true);
    expect(sha256(file)).not.toBe(before);
    const after = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: number };
    expect(after.schemaVersion).toBe(2);
  });
});

describe('loadConfigReadOnly 不装载 pricingHolidays（模块级状态副作用）', () => {
  it('只读读取 ⇒ 日历仍未配置', async () => {
    const file = writeV3('calendar.json');
    resetHolidayCalendar();
    expect(holidayCalendarStatus().configured, '前置：日历必须是未配置状态').toBe(false);

    await loadConfigReadOnly(file);

    expect(holidayCalendarStatus().configured).toBe(false);
    expect(holidayCalendarStatus().holidayCount).toBe(0);
  });

  it('**正例对照**：`loadConfig(file, { migrate: false })` ⇒ 日历被装载（证上一条不是恒真）', async () => {
    const file = writeV3('calendar2.json');
    resetHolidayCalendar();

    await loadConfig(file, { migrate: false });

    expect(holidayCalendarStatus().configured, '默认 loadConfig 必须装载日历').toBe(true);
    expect(holidayCalendarStatus().holidayCount).toBe(1);
  });
});
