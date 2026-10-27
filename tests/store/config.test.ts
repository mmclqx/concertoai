import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { holidayCalendarStatus, resetHolidayCalendar } from '../../src/core/holidays';
import { priceTierFor } from '../../src/model/models';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG_PATH,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_PEAK_TIME_STRATEGY,
  emptyConfig,
  isApprovalInsightMode,
  isHintsMode,
  isReflectionsMode,
  loadConfig,
  resolveConfig,
  validateConfigValues,
  writeConfig,
} from '../../src/store/config';
import { DEFAULT_SESSION_DIR } from '../../src/store/session';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-test-'));
  // 隔离本机系统 LANG / LUMEN_LOCALE（如 zh_CN.UTF-8 / en），避免影响「全部缺省」类断言
  // （v3.3 S1 验证时发现：shell 预设 LUMEN_LOCALE=en 会让「全部缺省 → zh」断言假失败）
  vi.stubEnv('LANG', '');
  vi.stubEnv('LUMEN_LOCALE', '');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  // 计价日历是模块级状态：必须复位，否则 loadConfig 的装载会污染后续用例
  resetHolidayCalendar();
});

describe('loadConfig / writeConfig', () => {
  it('文件不存在时返回空配置', async () => {
    const config = await loadConfig(path.join(tmp, 'config.json'));
    expect(config).toEqual(emptyConfig());
  });

  it('v4 格式写入后可读回（含目录自动创建）', async () => {
    const file = path.join(tmp, 'nested', 'config.json');
    await writeConfig(
      {
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: { deepseek: { type: 'deepseek', model: 'deepseek-v4-pro' } },
        legacy: { allowlist: ['npm test'] },
        _migrated: true,
      } as unknown as ReturnType<typeof emptyConfig>,
      file,
    );
    const config = await loadConfig(file);
    expect(config).toMatchObject({
      schemaVersion: 2,
      defaultProvider: 'deepseek',
      providers: { deepseek: { type: 'deepseek', model: 'deepseek-v4-pro' } },
    });
  });

  it('v3 配置读回时自动迁移（M3 T3.5）', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      { schemaVersion: 1, defaultModel: 'deepseek-v4-pro', allowlist: ['npm test'] },
      file,
    );
    const config = await loadConfig(file);
    expect(config).toMatchObject({
      schemaVersion: 2,
      defaultProvider: 'deepseek',
      _migrated: true,
      providers: { deepseek: { type: 'deepseek', model: 'deepseek-v4-pro' } },
    });
    const { readFileSync } = await import('node:fs');
    const backup = JSON.parse(readFileSync(`${file}.v3.bak`, 'utf8')) as {
      defaultModel?: string;
    };
    expect(backup.defaultModel).toBe('deepseek-v4-pro');
  });

  it('JSON 损坏时返回空配置（不抛错）', async () => {
    const file = path.join(tmp, 'config.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '{broken json', 'utf8');
    const config = await loadConfig(file);
    expect(config).toEqual(emptyConfig());
  });

  it('schema 版本不匹配时返回空配置', async () => {
    const file = path.join(tmp, 'config.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify({ schemaVersion: 999, defaultModel: 'x' }), 'utf8');
    const config = await loadConfig(file);
    expect(config).toEqual(emptyConfig());
  });

  it('默认配置路径为 ~/.concertoai/config.json', () => {
    expect(DEFAULT_CONFIG_PATH).toBe(path.join(os.homedir(), '.concertoai', 'config.json'));
    expect(CONFIG_SCHEMA_VERSION).toBe(1);
  });
});

describe('resolveConfig 优先级（CLI > 环境变量 > 配置文件 > 默认值）', () => {
  it('全部缺省时用内置默认', () => {
    const r = resolveConfig(emptyConfig());
    expect(r.model).toBeUndefined();
    expect(r.allowlist).toBeUndefined();
    expect(r.approvalPolicy).toBe('ask');
    expect(r.sessionDir).toBe(DEFAULT_SESSION_DIR);
    expect(r.locale).toBe('zh');
    // v2.2 智能成本控制：高峰策略与本地模型默认值
    expect(r.peakTimeStrategy).toBe(DEFAULT_PEAK_TIME_STRATEGY);
    expect(r.peakTimeStrategy).toBe('ask');
    expect(r.ollamaModel).toBe(DEFAULT_OLLAMA_MODEL);
    expect(r.ollamaModel).toBe('qwen3.6:27b-q4_K_M');
    expect(r.ollamaBaseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(r.ollamaBaseUrl).toBe('http://localhost:11434/v1');
  });

  it('配置文件生效', () => {
    const r = resolveConfig({
      schemaVersion: 1,
      defaultModel: 'deepseek-v4-pro',
      allowlist: ['npm test', 'git status'],
      approvalPolicy: 'allowlist-only',
      sessionDir: '/custom/sessions',
      locale: 'en',
      peakTimeStrategy: 'switch',
      ollamaModel: 'llama3:8b',
      ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(r.model).toBe('deepseek-v4-pro');
    expect(r.allowlist).toEqual(['npm test', 'git status']);
    expect(r.approvalPolicy).toBe('allowlist-only');
    expect(r.sessionDir).toBe('/custom/sessions');
    expect(r.locale).toBe('en');
    expect(r.peakTimeStrategy).toBe('switch');
    expect(r.ollamaModel).toBe('llama3:8b');
    expect(r.ollamaBaseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('环境变量覆盖配置文件', () => {
    vi.stubEnv('LUMEN_MODEL', 'deepseek-v4-flash');
    vi.stubEnv('LUMEN_ALLOWLIST', 'npm test, git diff');
    vi.stubEnv('LUMEN_SESSION_DIR', '/env/sessions');
    vi.stubEnv('LUMEN_LOCALE', 'en');
    const r = resolveConfig({
      schemaVersion: 1,
      defaultModel: 'deepseek-v4-pro',
      allowlist: ['npm test'],
      sessionDir: '/cfg/sessions',
      locale: 'zh',
    });
    expect(r.model).toBe('deepseek-v4-flash');
    expect(r.allowlist).toEqual(['npm test', 'git diff']);
    expect(r.sessionDir).toBe('/env/sessions');
    expect(r.locale).toBe('en');
  });

  it('CLI 参数覆盖环境变量', () => {
    vi.stubEnv('LUMEN_MODEL', 'deepseek-v4-flash');
    const r = resolveConfig(
      { schemaVersion: 1, defaultModel: 'deepseek-v4-pro' },
      'deepseek-v4-pro',
    );
    expect(r.model).toBe('deepseek-v4-pro');
  });

  it('白名单逗号解析：trim 并过滤空项', () => {
    vi.stubEnv('LUMEN_ALLOWLIST', ' npm test ,,git status ,');
    const r = resolveConfig(emptyConfig());
    expect(r.allowlist).toEqual(['npm test', 'git status']);
  });

  it('非法审批策略回退 ask', () => {
    vi.stubEnv('LUMEN_APPROVAL', 'whatever');
    expect(resolveConfig(emptyConfig()).approvalPolicy).toBe('ask');
  });

  it('非法 peakTimeStrategy 回退 ask（默认）', () => {
    const r = resolveConfig({
      schemaVersion: 1,
      peakTimeStrategy: 'whatever' as 'ask',
    });
    expect(r.peakTimeStrategy).toBe('ask');
    expect(r.ollamaModel).toBe(DEFAULT_OLLAMA_MODEL);
    expect(r.ollamaBaseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
  });

  it('locale 优先级：CLI --lang > LUMEN_LOCALE > LANG > 配置文件 > zh', () => {
    vi.stubEnv('LUMEN_LOCALE', 'en');
    vi.stubEnv('LANG', 'zh_CN.UTF-8');
    // CLI 最高
    expect(resolveConfig({ schemaVersion: 1, locale: 'zh' }, undefined, 'zh').locale).toBe('zh');
    // 环境变量高于配置
    expect(resolveConfig({ schemaVersion: 1, locale: 'zh' }).locale).toBe('en');
    // LANG 兜底（zh/en 前缀）——unstub 后需重新隔离 LUMEN_LOCALE（外部 shell 可能预设）
    vi.unstubAllEnvs();
    vi.stubEnv('LANG', 'zh_CN.UTF-8');
    vi.stubEnv('LUMEN_LOCALE', '');
    expect(resolveConfig({ schemaVersion: 1 }).locale).toBe('zh_CN.UTF-8');
    // LANG 非 zh/en 前缀时忽略，回退配置/默认
    vi.stubEnv('LANG', 'fr_FR.UTF-8');
    expect(resolveConfig({ schemaVersion: 1, locale: 'en' }).locale).toBe('en');
    expect(resolveConfig(emptyConfig()).locale).toBe('zh');
  });
});

describe('pricingHolidays 装载（v5.0 T7 修订）', () => {
  it('loadConfig 把 config.pricingHolidays 装载进计价日历', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        pricingHolidays: { holidays: ['2026-10-28'], makeupWorkdays: ['2026-10-31'] },
      },
      file,
    );
    await loadConfig(file);
    expect(holidayCalendarStatus()).toMatchObject({
      configured: true,
      holidayCount: 1,
      makeupCount: 1,
    });
    // 周四=节假日 → 计价空闲；周六=调休上班 → 计价高峰
    expect(priceTierFor(new Date(2026, 9, 28, 10, 0))).toBe('offpeak');
    expect(priceTierFor(new Date(2026, 9, 31, 10, 0))).toBe('peak');
  });

  it('配置为空 → 复位为未配置（幂等：每次 load 都以当前配置为准）', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      { schemaVersion: CONFIG_SCHEMA_VERSION, pricingHolidays: { holidays: ['2026-10-28'] } },
      file,
    );
    await loadConfig(file);
    expect(holidayCalendarStatus().configured).toBe(true);

    await writeConfig({ schemaVersion: CONFIG_SCHEMA_VERSION }, file);
    await loadConfig(file);
    expect(holidayCalendarStatus().configured).toBe(false);
  });

  it('【回归】v3 迁移后 legacy 里的字段必须摊平到顶层（否则白名单/策略静默失效）', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      {
        schemaVersion: CONFIG_SCHEMA_VERSION, // v3 → 触发迁移
        defaultModel: 'deepseek-v4-pro',
        allowlist: ['npm test'],
        peakTimeStrategy: 'ignore',
        pricingHolidays: { holidays: ['2026-10-28'] },
      } as unknown as Parameters<typeof writeConfig>[0],
      file,
    );
    const loaded = await loadConfig(file);
    // 迁移产生的遗留字段（v4 顶层本没有）必须补回顶层，否则用户配置「迁移成功但全失效」
    expect(loaded.allowlist).toEqual(['npm test']);
    expect(loaded.peakTimeStrategy).toBe('ignore');
    expect(loaded.pricingHolidays).toEqual({ holidays: ['2026-10-28'] });
    // 顶层不再残留 legacy 键（已摊平，避免消费方拿到双层结构）
    expect((loaded as unknown as { legacy?: unknown }).legacy).toBeUndefined();
    // 模型走 v4 的 providers 写法
    expect(resolveConfig(loaded).model).toBe('deepseek-v4-pro');
    // 节假日表已装载
    expect(holidayCalendarStatus().configured).toBe(true);
  });

  it('【回归】v4 顶层显式配置优先于 legacy 中的旧值', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      {
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: { deepseek: { type: 'deepseek', model: 'deepseek-v4-flash' } },
        allowlist: ['npm run build'], // 顶层（新）
        legacy: { allowlist: ['npm test'], locale: 'en' }, // 迁移遗留（旧）
      } as unknown as Parameters<typeof writeConfig>[0],
      file,
    );
    const loaded = await loadConfig(file);
    expect(loaded.allowlist).toEqual(['npm run build']); // 顶层赢
    expect(loaded.locale).toBe('en'); // 顶层缺失 → legacy 补齐
  });

  it('非法日期提示一次并忽略（不静默）', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        pricingHolidays: { holidays: ['2026-02-30', '2026-10-28'] },
      } as unknown as Parameters<typeof writeConfig>[0],
      file,
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await loadConfig(file);
      const told = err.mock.calls.map((c) => String(c[0])).join('\n');
      expect(told).toContain('2026-02-30');
      expect(told).toContain('非法日期');
      // 合法的那条仍然生效
      expect(holidayCalendarStatus().holidayCount).toBe(1);
    } finally {
      err.mockRestore();
    }
  });
});

/**
 * v5.0 T11：审批配置（approvalInsight / riskRules / reflections）的读写与解析。
 *
 * 三条验收要求落在这里：
 * 1. round-trip（写→读不变）+ 非法值友好报错（提示而非崩溃）；
 * 2. **v4.x 旧 config（没有这些字段）→ 默认值生效**（向后兼容，不因新增配置阻塞老用户）；
 * 3. 环境变量与 config 的优先级**只在 resolveConfig 一处实现**（避免入口层各写一份）。
 */
describe('v5.0 T11：审批配置项', () => {
  /**
   * 清掉全局测试环境的复盘开关（`tests/setup.ts` 把 `CONCERTOAI_REFLECTIONS` 设为 off，
   * 防止集成测试把记录写进开发者真实 home）。
   *
   * 但**本组要测的就是「默认值」与「环境变量优先级」本身**，带着 off 跑会把
   * 「默认 on」断言成 off——测试意图必须显式声明，不能靠环境巧合。
   */
  beforeEach(() => {
    vi.stubEnv('CONCERTOAI_REFLECTIONS', '');
    vi.stubEnv('CONCERTOAI_APPROVAL_INSIGHT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('三配置项 round-trip（approvalInsight / riskRules.disabled / reflections）', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        approvalInsight: 'plain',
        riskRules: { disabled: ['dependency-change'] },
        reflections: 'off',
      } as Parameters<typeof writeConfig>[0],
      file,
    );
    const loaded = await loadConfig(file);
    expect(loaded.approvalInsight).toBe('plain');
    expect(loaded.riskRules?.disabled).toEqual(['dependency-change']);
    expect(loaded.reflections).toBe('off');
    expect(validateConfigValues(loaded)).toEqual([]);
  });

  it('v4.x 旧 config 缺这些字段 → 默认 rich / on（向后兼容）', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        defaultModel: 'deepseek-v4-flash',
      } as Parameters<typeof writeConfig>[0],
      file,
    );
    const loaded = await loadConfig(file);
    expect(loaded.approvalInsight).toBeUndefined(); // 文件里没有
    const resolved = resolveConfig(loaded);
    expect(resolved.approvalInsight).toBe('rich'); // 解析层兜默认
    expect(resolved.reflections).toBe('on');
  });

  it('非法值不抛错、按默认值工作，但必须提示（不静默吞掉）', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        approvalInsight: 'fancy',
        reflections: 'maybe',
        riskRules: { disabled: 'dependency-change' },
      } as unknown as Parameters<typeof writeConfig>[0],
      file,
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const loaded = await loadConfig(file);
      const told = err.mock.calls.map((c) => String(c[0])).join('\n');
      expect(told).toContain('approvalInsight');
      expect(told).toContain('reflections');
      expect(told).toContain('riskRules.disabled');
      // 非法值 → resolveConfig 回落到默认
      const resolved = resolveConfig(loaded);
      expect(resolved.approvalInsight).toBe('rich');
      expect(resolved.reflections).toBe('on');
    } finally {
      err.mockRestore();
    }
  });

  it('validateConfigValues 单独可用（纯函数，非法/合法各一组）', () => {
    expect(validateConfigValues(emptyConfig())).toEqual([]);
    expect(
      validateConfigValues({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        approvalInsight: 'plain',
        reflections: 'off',
        riskRules: { disabled: ['network-timeout'] },
      }),
    ).toEqual([]);
    const issues = validateConfigValues({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      approvalInsight: 'x' as never,
      reflections: 'y' as never,
    });
    expect(issues.map((i) => i.key)).toEqual(['approvalInsight', 'reflections']);
    for (const issue of issues) {
      expect(issue.expected.length).toBeGreaterThan(0);
    }
  });

  it('环境变量优先于配置文件（允许运维临时切 plain / 关复盘）', () => {
    const base = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      approvalInsight: 'rich',
      reflections: 'on',
    };
    vi.stubEnv('CONCERTOAI_APPROVAL_INSIGHT', 'plain');
    vi.stubEnv('CONCERTOAI_REFLECTIONS', 'off');
    const resolved = resolveConfig(base as Parameters<typeof resolveConfig>[0]);
    expect(resolved.approvalInsight).toBe('plain');
    expect(resolved.reflections).toBe('off');
  });

  it('环境变量写错值 → 回落配置文件（不会把有效配置覆盖成非法）', () => {
    const base = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      approvalInsight: 'plain',
      reflections: 'off',
    };
    vi.stubEnv('CONCERTOAI_APPROVAL_INSIGHT', 'nonsense');
    vi.stubEnv('CONCERTOAI_REFLECTIONS', '');
    const resolved = resolveConfig(base as Parameters<typeof resolveConfig>[0]);
    expect(resolved.approvalInsight).toBe('plain');
    expect(resolved.reflections).toBe('off');
  });

  it('isApprovalInsightMode / isReflectionsMode：类型守卫只认合法值', () => {
    expect(isApprovalInsightMode('rich')).toBe(true);
    expect(isApprovalInsightMode('plain')).toBe(true);
    expect(isApprovalInsightMode('Rich')).toBe(false);
    expect(isApprovalInsightMode(undefined)).toBe(false);
    expect(isReflectionsMode('on')).toBe(true);
    expect(isReflectionsMode('off')).toBe(true);
    expect(isReflectionsMode('OFF')).toBe(false);
  });
});

/**
 * v5.0 T12：场景提示开关（config.hints）的读写与解析。
 *
 * 三件事必须有覆盖（遗留半成品在这三处全是缺口）：
 * 1. round-trip 写入读回不变；
 * 2. `resolveConfig` **合并环境变量**（消费者只读 `resolved.hints`，不自己读 env）；
 * 3. `validateConfigValues` 认得出非法值（写错字要提示，不能静默）。
 */
describe('v5.0 T12：场景提示开关 hints', () => {
  beforeEach(() => {
    // 显式声明意图：本组要测「默认 on」，不能被全局测试环境的 off 干扰
    vi.stubEnv('CONCERTOAI_HINTS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trip：写入 hints=off 后读回一致', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      { schemaVersion: CONFIG_SCHEMA_VERSION, hints: 'off' } as Parameters<typeof writeConfig>[0],
      file,
    );
    const loaded = await loadConfig(file);
    expect(loaded.hints).toBe('off');
    expect(validateConfigValues(loaded)).toEqual([]);
  });

  it('resolveConfig 默认 on（用户拍板的默认值），旧配置缺字段也返回 on', () => {
    expect(resolveConfig(emptyConfig()).hints).toBe('on');
    expect(
      resolveConfig({ schemaVersion: CONFIG_SCHEMA_VERSION, defaultModel: 'deepseek-v4-flash' })
        .hints,
    ).toBe('on');
  });

  it('环境变量优先于配置文件，且写错值回落 config（不静默推翻用户设置）', () => {
    const base = { schemaVersion: CONFIG_SCHEMA_VERSION, hints: 'on' as const };
    vi.stubEnv('CONCERTOAI_HINTS', 'off');
    expect(resolveConfig(base).hints).toBe('off');

    vi.stubEnv('CONCERTOAI_HINTS', 'ofl'); // 手滑
    expect(resolveConfig(base).hints).toBe('on'); // 回落配置文件
  });

  it('非法值：不抛错但必须提示（与 approvalInsight / reflections 同口径）', async () => {
    const file = path.join(tmp, 'config.json');
    await writeConfig(
      { schemaVersion: CONFIG_SCHEMA_VERSION, hints: 'maybe' } as unknown as Parameters<
        typeof writeConfig
      >[0],
      file,
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const loaded = await loadConfig(file);
      const told = err.mock.calls.map((c) => String(c[0])).join('\n');
      expect(told).toContain('hints');
      expect(resolveConfig(loaded).hints).toBe('on'); // 回落默认
    } finally {
      err.mockRestore();
    }
  });

  it('isHintsMode 只认合法值', () => {
    expect(isHintsMode('on')).toBe(true);
    expect(isHintsMode('off')).toBe(true);
    expect(isHintsMode('OFF')).toBe(false);
    expect(isHintsMode(undefined)).toBe(false);
    expect(isHintsMode(true)).toBe(false);
  });
});
