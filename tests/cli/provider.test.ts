/**
 * Provider CLI 测试（v4.0 M3 T3.1 / T3.2b / T3.5）。
 *
 * 覆盖：runProviderAuth 完整流程（输入→验证→保存 0600）/ --verify 仅验证不保存 /
 * runProviderSwitch 持久化切换 / runProviderList 状态输出。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProviderAuth, runProviderList, runProviderSwitch } from '../../src/cli/provider';

let tmp: string;
let log: ReturnType<typeof vi.spyOn> | undefined;
let errLog: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-provider-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  log?.mockRestore();
  errLog?.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** mock fetch：按 URL 分派——/models（openai）与 /user/balance（deepseek）均返回 ok。 */
function okFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/models')) {
      return jsonResponse({ data: [{ id: 'gpt-4o' }] });
    }
    return jsonResponse({ is_available: true, balance_infos: [] });
  }) as typeof fetch;
}

const accountsRoot = () => path.join(tmp, 'accounts');

describe('runProviderAuth（T3.2b）', () => {
  it('完整流程：验证通过 → 保存至 accounts/<name>/config.json（0600）+ 设 active', async () => {
    const code = await runProviderAuth({
      name: 'openai',
      key: 'sk-test-1234',
      accountsRoot: accountsRoot(),
      fetchImpl: okFetch(),
    });
    expect(code).toBe(0);
    const out = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('✅ Key 验证通过');
    expect(out).toContain('已保存 openai API Key');
    // 保存文件存在且 active 指针指向 openai
    const cfg = path.join(accountsRoot(), 'openai', 'config.json');
    expect(existsSync(cfg)).toBe(true);
    const saved = JSON.parse(readFileSync(cfg, 'utf8')) as { apiKey?: string };
    expect(saved.apiKey).toBe('sk-test-1234');
    const active = readFileSync(path.join(accountsRoot(), 'active-account'), 'utf8').trim();
    expect(active).toBe('openai');
  });

  it('--verify 仅验证不保存（accounts 目录无文件）', async () => {
    const code = await runProviderAuth({
      name: 'openai',
      key: 'sk-test-1234',
      verify: true,
      accountsRoot: accountsRoot(),
      fetchImpl: okFetch(),
    });
    expect(code).toBe(0);
    const out = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('--verify 仅验证，未保存');
    expect(existsSync(path.join(accountsRoot(), 'openai'))).toBe(false);
    expect(existsSync(path.join(accountsRoot(), 'active-account'))).toBe(false);
  });

  it('Key 验证失败 → 返回 1 不保存', async () => {
    const code = await runProviderAuth({
      name: 'deepseek',
      key: 'sk-bad',
      accountsRoot: accountsRoot(),
      fetchImpl: (async () => new Response('{"error":{}}', { status: 401 })) as typeof fetch,
    });
    expect(code).toBe(1);
    expect((errLog?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n')).toContain(
      '❌ Key 验证失败',
    );
    expect(existsSync(path.join(accountsRoot(), 'deepseek'))).toBe(false);
  });

  it('未知 Provider 名 → 返回 1（仅支持 deepseek/openai）', async () => {
    const code = await runProviderAuth({
      name: 'anthropic',
      key: 'sk-x',
      accountsRoot: accountsRoot(),
      fetchImpl: okFetch(),
    });
    expect(code).toBe(1);
    expect((errLog?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n')).toContain(
      '未知 Provider',
    );
  });

  it('交互输入被 Ctrl+C 取消（promptLine→undefined）→ authCanceled + 返回 1（v4.0.1）', async () => {
    process.stdin.isTTY = true;
    vi.resetModules();
    vi.doMock('../../src/cli/prompt', () => ({
      promptLine: async () => undefined,
    }));
    const { runProviderAuth: authDynamic } = await import('../../src/cli/provider');
    const code = await authDynamic({
      name: 'openai',
      accountsRoot: accountsRoot(),
      fetchImpl: okFetch(),
    });
    expect(code).toBe(1);
    expect((errLog?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n')).toContain(
      '已取消认证',
    );
  });
});

describe('runProviderSwitch（T3.1/T3.5）', () => {
  it('持久化切换 defaultProvider（写 config）', async () => {
    const cfg = path.join(tmp, 'config.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      cfg,
      JSON.stringify({
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: {
          deepseek: { type: 'deepseek', model: 'deepseek-v4-flash' },
          openai: { type: 'openai', model: 'gpt-4o' },
        },
        _migrated: true,
      }),
      'utf8',
    );
    const code = await runProviderSwitch({ name: 'openai', configPath: cfg });
    expect(code).toBe(0);
    const saved = JSON.parse(readFileSync(cfg, 'utf8')) as { defaultProvider?: string };
    expect(saved.defaultProvider).toBe('openai');
  });

  it('未知 Provider → 返回 1 不写盘', async () => {
    const cfg = path.join(tmp, 'config.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      cfg,
      JSON.stringify({ schemaVersion: 2, defaultProvider: 'deepseek', providers: {} }),
      'utf8',
    );
    const code = await runProviderSwitch({ name: 'ghost', configPath: cfg });
    expect(code).toBe(1);
    const saved = JSON.parse(readFileSync(cfg, 'utf8')) as { defaultProvider?: string };
    expect(saved.defaultProvider).toBe('deepseek');
  });
});

describe('runProviderList（T3.1）', () => {
  it('输出状态列表：可用/不可用 + 默认标记', async () => {
    const cfg = path.join(tmp, 'config.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      cfg,
      JSON.stringify({
        schemaVersion: 2,
        defaultProvider: 'deepseek',
        providers: {
          deepseek: { type: 'deepseek', model: 'deepseek-v4-flash' },
          ollama: { type: 'ollama' },
        },
        _migrated: true,
      }),
      'utf8',
    );
    const code = await runProviderList({
      configPath: cfg,
      accountsRoot: accountsRoot(),
      // deepseek 余额探测 → ok；ollama /api/tags → 无模型 → 不可用
      fetchImpl: (async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/tags')) {
          return jsonResponse({ models: [] });
        }
        return jsonResponse({ is_available: true, balance_infos: [] });
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    const out = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('可用 Provider');
    expect(out).toContain('🟢 deepseek（默认）');
    expect(out).toContain('🔴 ollama');
  });
});
