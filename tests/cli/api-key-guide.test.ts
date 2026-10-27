/**
 * 缺 API Key 中文引导测试（v5.0 T1）。
 *
 * 覆盖：
 * - 引导三方式 + 获取地址 + configPath 真实出现（G7 证据优先：写了就得有）；
 * - 输出行数上限（防「输出淹没」，AGENTS 边缘路径规范）；
 * - zh/en 双语（G4 i18n 双份）；
 * - 无占位符残留（`{xxx}` 未替换）；
 * - readConfigDeepseekKey：真实读取 providers.deepseek.apiKey（修复入口不生效缺口）+ 容错。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API_KEY_URL, buildMissingApiKeyGuide } from '../../src/cli/api-key-guide';
import { readConfigDeepseekKey } from '../../src/cli/common';
import { setLocale } from '../../src/i18n';

const CONFIG_PATH = path.join(os.tmpdir(), 'demo-home', '.concertoai', 'config.json');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'akg-'));
  setLocale('zh');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  setLocale('zh');
});

describe('buildMissingApiKeyGuide：缺 Key 引导内容（v5.0 T1）', () => {
  it('包含三种配置方式，且每种都有可复制的命令', () => {
    const text = buildMissingApiKeyGuide({ configPath: CONFIG_PATH }).join('\n');

    // 方式 1：环境变量（三 shell）
    expect(text).toContain('DEEPSEEK_API_KEY');
    expect(text).toContain('$env:DEEPSEEK_API_KEY='); // PowerShell
    expect(text).toContain('set DEEPSEEK_API_KEY='); // cmd.exe
    expect(text).toContain('export DEEPSEEK_API_KEY='); // bash/zsh

    // 方式 2：登录账号（真实存在的命令，见 src/cli/index.ts login）
    expect(text).toContain('concertoai login');

    // 方式 3：配置文件（必须展示真实路径 + 真实字段名）
    expect(text).toContain(CONFIG_PATH);
    expect(text).toContain('"apiKey"');
    expect(text).toContain('"deepseek"');
  });

  it('包含 Key 获取地址与 doctor 验证下一步', () => {
    const text = buildMissingApiKeyGuide({ configPath: CONFIG_PATH }).join('\n');
    expect(text).toContain(API_KEY_URL);
    expect(text).toContain('concertoai doctor');
  });

  it('输出行数受控（≤ 20 行，防输出淹没）', () => {
    const lines = buildMissingApiKeyGuide({ configPath: CONFIG_PATH });
    expect(lines.length).toBeLessThanOrEqual(20);
    // 不应出现连续 2 行以上空白（排版紧凑）
    const maxBlankRun = lines
      .join('\n')
      .split('\n')
      .reduce(
        (acc, line) => {
          const blank = line.trim() === '' ? acc.current + 1 : 0;
          return { current: blank, max: Math.max(acc.max, blank) };
        },
        { current: 0, max: 0 },
      ).max;
    expect(maxBlankRun).toBeLessThanOrEqual(1);
  });

  it('无未替换占位符（{xxx} 残留会误导用户）', () => {
    const text = buildMissingApiKeyGuide({ configPath: CONFIG_PATH }).join('\n');
    expect(text).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9_]*\}/);
  });

  it('英文环境下同样给出三种方式（G4 双语）', () => {
    setLocale('en');
    const text = buildMissingApiKeyGuide({ configPath: CONFIG_PATH }).join('\n');
    expect(text).toContain('DeepSeek API key not found');
    expect(text).toContain('environment variable');
    // 命令片段跨语言一致（不翻译命令）
    expect(text).toContain('export DEEPSEEK_API_KEY=');
    expect(text).toContain(CONFIG_PATH);
  });
});

describe('readConfigDeepseekKey：config.json 的 providers.deepseek.apiKey（v5.0 T1 缺口修复）', () => {
  it('读取到 providers.deepseek.apiKey', async () => {
    const file = path.join(tmp, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 2, providers: { deepseek: { apiKey: 'sk-test-1234' } } }),
      'utf8',
    );
    await expect(readConfigDeepseekKey(file)).resolves.toBe('sk-test-1234');
  });

  it('无 providers 字段 → undefined（不抛错）', async () => {
    const file = path.join(tmp, 'config.json');
    writeFileSync(file, JSON.stringify({ locale: 'zh' }), 'utf8');
    await expect(readConfigDeepseekKey(file)).resolves.toBeUndefined();
  });

  it('apiKey 为空串 → undefined（视为未配置）', async () => {
    const file = path.join(tmp, 'config.json');
    writeFileSync(file, JSON.stringify({ providers: { deepseek: { apiKey: '   ' } } }), 'utf8');
    await expect(readConfigDeepseekKey(file)).resolves.toBeUndefined();
  });

  it('文件不存在 / 损坏 JSON → undefined（容错不崩）', async () => {
    await expect(readConfigDeepseekKey(path.join(tmp, 'nope.json'))).resolves.toBeUndefined();

    const broken = path.join(tmp, 'broken.json');
    writeFileSync(broken, '{ not valid json', 'utf8');
    await expect(readConfigDeepseekKey(broken)).resolves.toBeUndefined();
  });
});
