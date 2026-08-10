import { describe, expect, it, vi } from 'vitest';

import { applyPeakStrategy, maybeSwitchModel } from '../../src/core/model-switcher';
import {
  type ConcertoAIConfig,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_PEAK_TIME_STRATEGY,
} from '../../src/store/config';

const OLLAMA_MODEL = 'qwen3.6:27b-q4_K_M';
const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const MAIN_MODEL = 'deepseek-v4-flash';

/** 周一 10:00 = 工作日高峰时段。 */
const PEAK = new Date(2026, 7, 3, 10, 0);
/** 周一 20:00 = 工作日非高峰时段。 */
const OFF_PEAK = new Date(2026, 7, 3, 20, 0);

const BASE_OPTIONS = {
  currentModel: MAIN_MODEL,
  strategy: 'ask' as const,
  ollamaModel: OLLAMA_MODEL,
  ollamaBaseUrl: OLLAMA_BASE_URL,
};

function captureLog(): { logs: string[]; log: (m: string) => void } {
  const logs: string[] = [];
  return { logs, log: (m: string) => logs.push(m) };
}

describe('applyPeakStrategy', () => {
  it('非高峰时段：保持主模型且不输出提示（不打扰）', async () => {
    const { logs, log } = captureLog();
    const result = await applyPeakStrategy({
      ...BASE_OPTIONS,
      now: OFF_PEAK,
      strategy: 'switch',
      log,
    });
    expect(result).toEqual({ model: MAIN_MODEL, switched: false });
    expect(logs).toEqual([]);
  });

  it('strategy=switch：高峰时段直接切换到本地模型', async () => {
    const { logs, log } = captureLog();
    const result = await applyPeakStrategy({ ...BASE_OPTIONS, now: PEAK, strategy: 'switch', log });
    expect(result.model).toBe(OLLAMA_MODEL);
    expect(result.switched).toBe(true);
    expect(logs).toEqual([`已切换到本地模型 ${OLLAMA_MODEL}（${OLLAMA_BASE_URL}）`]);
  });

  it('strategy=ignore：高峰时段保持主模型并提示', async () => {
    const { logs, log } = captureLog();
    const result = await applyPeakStrategy({ ...BASE_OPTIONS, now: PEAK, strategy: 'ignore', log });
    expect(result).toEqual({
      model: MAIN_MODEL,
      switched: false,
      message: `高峰时段已配置为忽略切换，保持主模型 ${MAIN_MODEL}`,
    });
    expect(logs).toEqual([`高峰时段已配置为忽略切换，保持主模型 ${MAIN_MODEL}`]);
  });

  it('strategy=ask + 交互确认 yes：切换到本地模型', async () => {
    const { logs, log } = captureLog();
    const result = await applyPeakStrategy({
      ...BASE_OPTIONS,
      now: PEAK,
      strategy: 'ask',
      interactive: true,
      confirm: async () => true,
      log,
    });
    expect(result.model).toBe(OLLAMA_MODEL);
    expect(result.switched).toBe(true);
    expect(logs).toEqual([`已切换到本地模型 ${OLLAMA_MODEL}（${OLLAMA_BASE_URL}）`]);
  });

  it('strategy=ask + 交互确认 no：保持主模型并提示', async () => {
    const { logs, log } = captureLog();
    const result = await applyPeakStrategy({
      ...BASE_OPTIONS,
      now: PEAK,
      strategy: 'ask',
      interactive: true,
      confirm: async () => false,
      log,
    });
    expect(result.model).toBe(MAIN_MODEL);
    expect(result.switched).toBe(false);
    expect(logs).toEqual([`已保持主模型 ${MAIN_MODEL}`]);
  });

  it('strategy=ask + 非交互环境：保持主模型并提示跳过', async () => {
    const { logs, log } = captureLog();
    const result = await applyPeakStrategy({
      ...BASE_OPTIONS,
      now: PEAK,
      strategy: 'ask',
      interactive: false,
      confirm: vi.fn(async () => true),
      log,
    });
    expect(result.model).toBe(MAIN_MODEL);
    expect(result.switched).toBe(false);
    expect(logs).toEqual([`非交互环境，跳过高峰模型切换，保持主模型 ${MAIN_MODEL}`]);
  });

  it('strategy=ask + 缺省 interactive（false）：不调用 confirm', async () => {
    const confirm = vi.fn(async () => true);
    const { log } = captureLog();
    await applyPeakStrategy({ ...BASE_OPTIONS, now: PEAK, strategy: 'ask', confirm, log });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('maybeSwitchModel（配置感知入口）', () => {
  it('读取配置 peakTimeStrategy=switch：高峰时段返回本地模型', async () => {
    const config: ConcertoAIConfig = {
      schemaVersion: 1,
      defaultModel: MAIN_MODEL,
      peakTimeStrategy: 'switch',
    };
    const result = await maybeSwitchModel({ config, now: PEAK, interactive: true });
    expect(result.model).toBe(DEFAULT_OLLAMA_MODEL);
    expect(result.switched).toBe(true);
  });

  it('读取配置 peakTimeStrategy=ignore：高峰时段保持主模型', async () => {
    const config: ConcertoAIConfig = {
      schemaVersion: 1,
      defaultModel: 'deepseek-v4-pro',
      peakTimeStrategy: 'ignore',
    };
    const result = await maybeSwitchModel({ config, now: PEAK });
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.switched).toBe(false);
  });

  it('cliModel 优先于配置 defaultModel', async () => {
    const config: ConcertoAIConfig = {
      schemaVersion: 1,
      defaultModel: 'deepseek-v4-pro',
      peakTimeStrategy: 'ignore',
    };
    const result = await maybeSwitchModel({ config, cliModel: MAIN_MODEL, now: PEAK });
    expect(result.model).toBe(MAIN_MODEL);
  });

  it('缺省配置：strategy=ask（非交互）保持主模型，本地模型用默认值', async () => {
    const { logs, log } = captureLog();
    const result = await maybeSwitchModel({
      config: { schemaVersion: 1, defaultModel: MAIN_MODEL },
      now: PEAK,
      interactive: false,
      log,
    });
    expect(result.model).toBe(MAIN_MODEL);
    expect(result.switched).toBe(false);
    expect(logs).toEqual([`非交互环境，跳过高峰模型切换，保持主模型 ${MAIN_MODEL}`]);
  });

  it('缺省配置 + 交互确认 yes：切换到默认 ollama 模型', async () => {
    const result = await maybeSwitchModel({
      config: { schemaVersion: 1, defaultModel: MAIN_MODEL },
      now: PEAK,
      interactive: true,
      confirm: async () => true,
    });
    expect(result.model).toBe(DEFAULT_OLLAMA_MODEL);
    expect(result.switched).toBe(true);
    expect(DEFAULT_PEAK_TIME_STRATEGY).toBe('ask');
    expect(DEFAULT_OLLAMA_MODEL).toBe('qwen3.6:27b-q4_K_M');
    expect(DEFAULT_OLLAMA_BASE_URL).toBe('http://localhost:11434/v1');
  });

  it('自定义 ollamaModel / ollamaBaseUrl 生效', async () => {
    const config: ConcertoAIConfig = {
      schemaVersion: 1,
      defaultModel: MAIN_MODEL,
      peakTimeStrategy: 'switch',
      ollamaModel: 'llama3:8b',
      ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
    };
    const result = await maybeSwitchModel({ config, now: PEAK });
    expect(result.model).toBe('llama3:8b');
    expect(result.message).toContain('http://127.0.0.1:11434/v1');
  });

  it('config 缺省时读取真实配置文件（~/.concertoai/config.json，不抛错）', async () => {
    const result = await maybeSwitchModel({ now: PEAK, interactive: false });
    expect(typeof result.model).toBe('string');
    expect(typeof result.switched).toBe('boolean');
  });
});
