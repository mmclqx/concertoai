import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG_PATH,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_PEAK_TIME_STRATEGY,
  emptyConfig,
  loadConfig,
  resolveConfig,
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
