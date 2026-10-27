/**
 * `auto` 模型预设测试（v5.0 T6，保守方案）。
 *
 * 重点（比功能更重要的三条）；
 * 1. **无自动升级路径**——`auto` 只解析成一个固定起始模型，不存在「复杂就变贵」的分支；
 * 2. 成本对比按**同一时刻同一档位**计算（不能在高峰算一个、空闲算另一个）；
 * 3. 升级方向必须确认（在 slash 层验证），降级方向直接生效。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { resolveModel } from '../../src/cli/common';
import {
  AUTO_MODEL,
  buildAutoPolicyGuide,
  buildUpgradeHint,
  isAutoModel,
  normalizeModelValue,
  quoteSwitch,
  resolveAutoStartModel,
  switchDirection,
  upgradeTargetFor,
} from '../../src/model/auto';
import { getDefaultModel, getModel, listModels } from '../../src/model/models';
import {
  CONFIG_SCHEMA_VERSION,
  type ConcertoAIConfig,
  loadConfig,
  resolveModelFromConfig,
  writeConfig,
} from '../../src/store/config';

/** 周三 10:00 → 计价高峰。 */
const PEAK_AT = new Date(2026, 9, 28, 10, 0, 0);
/** 周三 20:00 → 空闲。 */
const OFFPEAK_AT = new Date(2026, 9, 28, 20, 0, 0);

describe('auto 预设解析', () => {
  it('AUTO_MODEL 常量为 "auto"', () => {
    expect(AUTO_MODEL).toBe('auto');
  });

  it('isAutoModel 大小写与空白容错', () => {
    expect(isAutoModel('auto')).toBe(true);
    expect(isAutoModel('AUTO')).toBe(true);
    expect(isAutoModel(' Auto ')).toBe(true);
    expect(isAutoModel('flash')).toBe(false);
    expect(isAutoModel(undefined)).toBe(false);
    expect(isAutoModel('')).toBe(false);
  });

  it('auto 起始模型 = 默认档（保守：先花最少的钱）', () => {
    expect(resolveAutoStartModel()).toBe(getDefaultModel().id);
    expect(resolveAutoStartModel()).toBe('deepseek-v4-flash');
  });

  it('normalizeModelValue：auto→起始模型 / 已知→原样 / 未知→undefined', () => {
    expect(normalizeModelValue('auto')).toBe('deepseek-v4-flash');
    expect(normalizeModelValue('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(normalizeModelValue('no-such-model')).toBeUndefined();
    expect(normalizeModelValue(undefined)).toBeUndefined();
  });

  it('【红线】auto 解析结果与时间/任务复杂度无关（不存在自动升级分支）', () => {
    // 同一输入在任何时刻、任何调用次数下都必须得到同一模型
    for (let i = 0; i < 5; i += 1) {
      expect(normalizeModelValue('auto')).toBe('deepseek-v4-flash');
      expect(resolveAutoStartModel()).toBe('deepseek-v4-flash');
    }
    // auto 只接受一个参数（值），签名层面就传不进「复杂度/时刻」这类信号
    expect(normalizeModelValue.length).toBe(1);
  });
});

describe('升级目标与方向（决定是否需要确认）', () => {
  it('flash 的升级目标是 pro', () => {
    expect(upgradeTargetFor('deepseek-v4-flash')?.id).toBe('deepseek-v4-pro');
  });

  it('已是最高档 → 无升级目标', () => {
    expect(upgradeTargetFor('deepseek-v4-pro')).toBeUndefined();
  });

  it('未知模型 → 无升级目标（不猜）', () => {
    expect(upgradeTargetFor('no-such-model')).toBeUndefined();
  });

  it('switchDirection：变贵=upgrade / 变便宜=downgrade / 相同=same', () => {
    expect(switchDirection('deepseek-v4-flash', 'deepseek-v4-pro')).toBe('upgrade');
    expect(switchDirection('deepseek-v4-pro', 'deepseek-v4-flash')).toBe('downgrade');
    expect(switchDirection('deepseek-v4-flash', 'deepseek-v4-flash')).toBe('same');
  });

  it('switchDirection：未知模型按 upgrade（fail-closed 需确认）', () => {
    expect(switchDirection('deepseek-v4-flash', 'no-such-model')).toBe('upgrade');
    expect(switchDirection('no-such-model', 'deepseek-v4-flash')).toBe('upgrade');
  });
});

describe('quoteSwitch：成本对比（同时刻同档位）', () => {
  it('flash→pro 成本倍率 = 按示例用量实算（空闲档约 3.67 倍，随价格表变动）', () => {
    const quote = quoteSwitch('deepseek-v4-flash', 'deepseek-v4-pro', OFFPEAK_AT);
    expect(quote.tier).toBe('offpeak');
    // 官方定价核对值下的实算：flash 0.00948 元 vs pro 0.0348 元（示例用量）
    expect(quote.fromCost).toBeCloseTo(0.00948, 6);
    expect(quote.toCost).toBeCloseTo(0.0348, 6);
    expect(quote.ratio).toBeCloseTo(0.0348 / 0.00948, 4);
  });

  it('高峰档比率不变（两模型同步翻倍，结论不因时段漂移）', () => {
    const off = quoteSwitch('deepseek-v4-flash', 'deepseek-v4-pro', OFFPEAK_AT);
    const peak = quoteSwitch('deepseek-v4-flash', 'deepseek-v4-pro', PEAK_AT);
    expect(peak.tier).toBe('peak');
    expect(peak.ratio).toBeCloseTo(off.ratio);
    // 绝对成本翻倍，但比率不变——对比结论不能被时段左右
    expect(peak.toCost).toBeCloseTo(off.toCost * 2);
  });

  it('对比口径与 doctor 月成本预估一致（默认示例用量）', () => {
    const quote = quoteSwitch('deepseek-v4-flash', 'deepseek-v4-pro', OFFPEAK_AT);
    expect(quote.sample).toEqual({ input: 8_000, output: 1_200, cacheHit: 4_000 });
  });

  it('同模型自比 → 倍率 1', () => {
    expect(quoteSwitch('deepseek-v4-pro', 'deepseek-v4-pro', OFFPEAK_AT).ratio).toBeCloseTo(1);
  });

  it('未知模型抛错（不静默返回 0 骗用户）', () => {
    expect(() => quoteSwitch('no-such-model', 'deepseek-v4-pro')).toThrow('未知模型');
  });
});

describe('buildAutoPolicyGuide：策略说明必须讲清「不会自动升级」', () => {
  it('包含当前时段单价与档位标注', () => {
    const text = buildAutoPolicyGuide(OFFPEAK_AT).join('\n');
    expect(text).toContain('空闲价');
    expect(text).toContain('¥1/百万');
  });

  it('【红线】明确写出「不会自动升级」', () => {
    const text = buildAutoPolicyGuide(PEAK_AT).join('\n');
    expect(text).toContain('不会自动升级');
  });

  it('给出可复制的升级命令与成本倍数', () => {
    const text = buildAutoPolicyGuide(OFFPEAK_AT).join('\n');
    expect(text).toContain('/model deepseek-v4-pro');
    expect(text).toContain('3.7 倍');
  });

  it('说明不超过 6 行（防止新手被淹没）', () => {
    expect(buildAutoPolicyGuide(OFFPEAK_AT).length).toBeLessThanOrEqual(6);
  });

  it('每行都是有效内容（无空行/无 undefined 泄漏）', () => {
    const lines = buildAutoPolicyGuide(OFFPEAK_AT);
    for (const line of lines) {
      expect(line.trim()).not.toBe('');
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('NaN');
    }
  });
});

describe('buildUpgradeHint：只提示不切换', () => {
  it('flash 上有提示，含手动命令', () => {
    const hint = buildUpgradeHint('deepseek-v4-flash', OFFPEAK_AT);
    expect(hint).toContain('/model deepseek-v4-pro');
    expect(hint).toContain('需确认');
  });

  it('最高档无提示', () => {
    expect(buildUpgradeHint('deepseek-v4-pro', OFFPEAK_AT)).toBeUndefined();
  });

  it('提示文本不包含任何自动切换语义（无「已切换」字样）', () => {
    const hint = buildUpgradeHint('deepseek-v4-flash', OFFPEAK_AT) ?? '';
    expect(hint).not.toContain('已切换');
    expect(hint).not.toContain('自动切换');
  });
});

describe('模型表完整性（auto 依赖的价格数据）', () => {
  it('至少两档且按输出价升序可比较（升级目标判定基础）', () => {
    const sorted = [...listModels()].sort((a, b) => a.offPeak.output - b.offPeak.output);
    expect(sorted.length).toBeGreaterThanOrEqual(2);
    expect(sorted[0]?.offPeak.output).toBeLessThan(sorted[1]?.offPeak.output ?? 0);
  });

  it('起始模型在模型表内（否则 quoteSwitch 会抛错）', () => {
    expect(getModel(resolveAutoStartModel())).toBeDefined();
  });
});

describe('config 接受 "auto"（T6 验收①：round-trip 正确）', () => {
  it('v4 形态（providers.deepseek.model）写盘 → 读回仍为 "auto"（配置层不改写用户选择）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'auto-cfg-'));
    const file = path.join(dir, 'config.json');
    try {
      await writeConfig(
        {
          schemaVersion: 2,
          defaultProvider: 'deepseek',
          providers: { deepseek: { type: 'deepseek', model: AUTO_MODEL } },
        } as unknown as ConcertoAIConfig,
        file,
      );
      const loaded = await loadConfig(file);
      // 规范化只发生在入口层（resolveModel），配置解析层原样透出「用户写的值」
      expect(resolveModelFromConfig(loaded)).toBe(AUTO_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v3 形态（defaultModel）→ 自动迁移时 "auto" 透传到 providers.deepseek.model（不丢字面值）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'auto-mig-'));
    const file = path.join(dir, 'config.json');
    try {
      await writeConfig({ schemaVersion: CONFIG_SCHEMA_VERSION, defaultModel: AUTO_MODEL }, file);
      const loaded = await loadConfig(file);
      expect(resolveModelFromConfig(loaded)).toBe(AUTO_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('入口层 resolveModel 把 auto 规范化为默认档，并**明确告知**实际模型（不静默替换）', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveModel(AUTO_MODEL)).toBe('deepseek-v4-flash');
      const told = stderr.mock.calls.map((c) => String(c[0])).join('\n');
      expect(told).toContain('auto 预设');
      expect(told).toContain('不会自动升级');
    } finally {
      stderr.mockRestore();
    }
  });

  it('普通模型值不受影响（不额外打提示）', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveModel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('公共 API（barrel 导出，供第三方复用）', () => {
  it('src/index.ts 导出 auto 模块的公开函数与常量', async () => {
    const api = await import('../../src/index');
    expect(api.AUTO_MODEL).toBe('auto');
    expect(typeof api.isAutoModel).toBe('function');
    expect(typeof api.resolveAutoStartModel).toBe('function');
    expect(typeof api.normalizeModelValue).toBe('function');
    expect(typeof api.upgradeTargetFor).toBe('function');
    expect(typeof api.quoteSwitch).toBe('function');
    expect(typeof api.switchDirection).toBe('function');
    expect(typeof api.buildAutoPolicyGuide).toBe('function');
    expect(typeof api.buildUpgradeHint).toBe('function');
  });
});

describe('【源码级红线】不存在无监督自动升级路径（v5.0 T6 验收）', () => {
  /** 读取源码文本（只读，用于护栏断言）。 */
  function readSource(rel: string): string {
    return readFileSync(path.join(process.cwd(), rel), 'utf8');
  }

  it('auto 模块不含「按任务复杂度自动选模型」的分支', () => {
    const src = readSource('src/model/auto.ts');
    // 不得引入复杂度判定（凡出现相关标识即视为越界，需人工复核）
    expect(src).not.toContain('detectComplexity');
    expect(src).not.toContain('recommendProvider');
    // auto 的起始模型必须由默认模型决定（无第二处决策点）
    expect(src).toContain('getDefaultModel()');
  });

  it('slash 层切换必须经过方向判定（不存在无脑直接切换）', () => {
    const src = readSource('src/cli/slash/model.ts');
    expect(src).toContain('switchDirection');
    // 升级分支必须调用 confirm
    expect(src).toContain('ctx.confirm');
    // 不得出现「自动/后台」字样驱动的切换
    expect(src).not.toContain('setInterval');
    expect(src).not.toContain('setTimeout');
  });

  it('App 层仅在用户显式执行 /model 时改变模型状态', () => {
    const src = readSource('src/ui/App.tsx');
    // setModel 只在 /model 命令处理块内被调用
    const calls = [...src.matchAll(/setModel\(/g)].length;
    expect(calls).toBe(1);
    // 该调用必须在 executeModelCommand 结果处理块中
    const idx = src.indexOf('setModel(');
    const block = src.slice(Math.max(0, idx - 800), idx);
    expect(block).toContain('modelResult');
  });
});
