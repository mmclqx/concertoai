/**
 * CLI 共享模块缓存测试（v3.2 M4 / T4.5：启动期缓存消除重复 I/O）。
 *
 * 覆盖：
 * - resolveApiKeyCached：同 accountsRoot 命中缓存（active 切换后仍返回首次值），clear 后刷新；
 * - 不同 accountsRoot 不共享缓存；
 * - loadProjectRegistryCached：同 registryFile 命中缓存（同一实例），clear 后重载。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearApiKeyCache,
  clearProjectRegistryCache,
  loadProjectRegistryCached,
  parseMaxTurnsOption,
  resolveApiKeyCached,
  resolveApiKeyWithConfigFallback,
} from '../../src/cli/common';
import { MAX_TURNS_CAP } from '../../src/loop/loop';
import { saveAccount, setActiveAccount } from '../../src/store/accounts';
import { ProjectRegistry } from '../../src/store/projects';

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'common-cache-'));
  root = path.join(tmp, 'accounts');
  clearApiKeyCache();
  clearProjectRegistryCache();
});

afterEach(() => {
  clearApiKeyCache();
  clearProjectRegistryCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveApiKeyCached（T4.5 启动期缓存）', () => {
  it('同 accountsRoot 命中缓存；clear 后重新解析最新 active', async () => {
    await saveAccount('work', 'sk-work-xxxx', { accountsRoot: root });
    await saveAccount('other', 'sk-other-xxxx', { accountsRoot: root });
    await setActiveAccount('work', root);

    const first = await resolveApiKeyCached({ envKey: '', accountsRoot: root });
    expect(first).toMatchObject({ key: 'sk-work-xxxx', source: 'account', accountName: 'work' });

    // 切换 active 后再次调用 → 命中缓存，仍返回首次解析值（不重新读盘）
    await setActiveAccount('other', root);
    const second = await resolveApiKeyCached({ envKey: '', accountsRoot: root });
    expect(second).toEqual(first);

    // clear 后重新解析 → 读取新 active
    clearApiKeyCache();
    const third = await resolveApiKeyCached({ envKey: '', accountsRoot: root });
    expect(third).toMatchObject({ key: 'sk-other-xxxx', source: 'account', accountName: 'other' });
  });

  it('不同 accountsRoot 不共享缓存', async () => {
    const root2 = path.join(tmp, 'accounts2');
    await saveAccount('work', 'sk-a-xxxx', { accountsRoot: root });
    await setActiveAccount('work', root);
    await saveAccount('work2', 'sk-b-xxxx', { accountsRoot: root2 });
    await setActiveAccount('work2', root2);

    const a = await resolveApiKeyCached({ envKey: '', accountsRoot: root });
    expect(a.accountName).toBe('work');
    const b = await resolveApiKeyCached({ envKey: '', accountsRoot: root2 });
    expect(b.accountName).toBe('work2');
  });
});

/**
 * `resolveApiKeyWithConfigFallback`（v5.0 K2 修复的核心）。
 *
 * 这条链是**「引导里写的三种方式」与「doctor 报告的 Key 状态」共用的唯一实现**：
 * 少一层回退，用户就会遇到「照引导配好 → 照引导去 doctor 验证 → 被告知未设置」。
 *
 * 契约（按优先级）：
 * 1. CLI / 环境变量 / active 账号（沿用 `resolveApiKey` 既有链，`source` 原样透传）；
 * 2. 都没有时回退到 `config.json` 的 `providers.deepseek.apiKey`，`source = 'config'`；
 * 3. 仍然没有 → `{ key: undefined, source: 'none' }`（**不抛错、不退出**，由调用方决定怎么办）。
 */
describe('resolveApiKeyWithConfigFallback（K2：config 回退）', () => {
  const writeConfig = (body: unknown): string => {
    const file = path.join(tmp, 'config.json');
    writeFileSync(file, JSON.stringify(body), 'utf8');
    return file;
  };

  it('★ 只有 config.json 里有 key（无 env / 无账号）→ 返回它且 source=config', async () => {
    const file = writeConfig({
      schemaVersion: 2,
      defaultProvider: 'deepseek',
      providers: {
        deepseek: { type: 'deepseek', apiKey: 'sk-config-only', model: 'deepseek-v4-flash' },
      },
    });
    const resolved = await resolveApiKeyWithConfigFallback({
      envKey: '',
      accountsRoot: root,
      configFile: file,
    });
    expect(resolved).toEqual({ key: 'sk-config-only', source: 'config' });
  });

  it('环境变量优先于 config.json（既有优先级不被打乱）', async () => {
    const file = writeConfig({
      schemaVersion: 2,
      defaultProvider: 'deepseek',
      providers: { deepseek: { type: 'deepseek', apiKey: 'sk-from-config' } },
    });
    const resolved = await resolveApiKeyWithConfigFallback({
      envKey: 'sk-from-env',
      accountsRoot: root,
      configFile: file,
    });
    expect(resolved).toMatchObject({ key: 'sk-from-env', source: 'env' });
  });

  it('哪里都没有 key → source=none（不抛错，由调用方决定报错还是继续）', async () => {
    const file = writeConfig({ schemaVersion: 2, providers: {} });
    const resolved = await resolveApiKeyWithConfigFallback({
      envKey: '',
      accountsRoot: root,
      configFile: file,
    });
    expect(resolved).toEqual({ key: undefined, source: 'none' });
  });

  it('config.json 不存在 / 损坏 / apiKey 为空串 → 一律 source=none（不抛错）', async () => {
    const missing = path.join(tmp, 'nope.json');
    for (const file of [missing]) {
      const resolved = await resolveApiKeyWithConfigFallback({
        envKey: '',
        accountsRoot: root,
        configFile: file,
      });
      expect(resolved.source).toBe('none');
    }
    const broken = path.join(tmp, 'broken.json');
    writeFileSync(broken, 'not-json{', 'utf8');
    expect(
      (
        await resolveApiKeyWithConfigFallback({
          envKey: '',
          accountsRoot: root,
          configFile: broken,
        })
      ).source,
    ).toBe('none');
    const blank = writeConfig({
      schemaVersion: 2,
      defaultProvider: 'deepseek',
      providers: { deepseek: { type: 'deepseek', apiKey: '   ' } },
    });
    expect(
      (await resolveApiKeyWithConfigFallback({ envKey: '', accountsRoot: root, configFile: blank }))
        .source,
    ).toBe('none');
  });
});

/**
 * `-t/--max-turns` 解析（v5.0 架构修正）。
 *
 * 这是「手滑不崩任务」的唯一保证点：所有非法输入都必须落成
 * `{ maxTurns: undefined, invalid: true }`（调用方提示后继续走 config > 默认），
 * 而不是 NaN / 0 / 静默改值的数字。
 */
describe('parseMaxTurnsOption（-t/--max-turns 校验）', () => {
  it('未传 → undefined 且不算写错（走 config.maxTurns > 默认）', () => {
    expect(parseMaxTurnsOption(undefined)).toEqual({ maxTurns: undefined, invalid: false });
  });

  it('合法正整数 → 原值返回，且不报错', () => {
    for (const raw of ['1', '12', ' 30 ', '+45', String(MAX_TURNS_CAP)]) {
      const parsed = parseMaxTurnsOption(raw);
      expect(parsed.invalid).toBe(false);
      expect(parsed.maxTurns).toBe(Number(raw.trim()));
    }
  });

  it('无效字符串 → invalid（不返回 NaN）', () => {
    for (const raw of ['', '   ', 'abc', '5x', '1.5', '1e3', '0x10', 'NaN', 'Infinity']) {
      const parsed = parseMaxTurnsOption(raw);
      expect(parsed).toEqual({ maxTurns: undefined, invalid: true });
    }
  });

  it('0 与负数 → invalid（0 会让工具循环一轮都不跑）', () => {
    for (const raw of ['0', '-1', '-50', '000', '-0']) {
      expect(parseMaxTurnsOption(raw)).toEqual({ maxTurns: undefined, invalid: true });
    }
  });

  it('超过硬上限 → invalid（不静默夹取，提示里告知接受范围）', () => {
    const parsed = parseMaxTurnsOption(String(MAX_TURNS_CAP + 1));
    expect(parsed).toEqual({ maxTurns: undefined, invalid: true });
    // 极端手滑（远超上限 / 长数字串）同样落到 invalid，不会溢出成 Infinity 或 0
    expect(parseMaxTurnsOption('5000').invalid).toBe(true);
    expect(parseMaxTurnsOption('9'.repeat(30)).invalid).toBe(true);
  });

  it('边界：恰好在上下限内合法，差 1 就非法（off-by-one 护栏）', () => {
    expect(parseMaxTurnsOption(String(MAX_TURNS_CAP)).maxTurns).toBe(MAX_TURNS_CAP);
    expect(parseMaxTurnsOption(String(MAX_TURNS_CAP + 1)).maxTurns).toBeUndefined();
    expect(parseMaxTurnsOption('1').maxTurns).toBe(1);
    expect(parseMaxTurnsOption('0').maxTurns).toBeUndefined();
  });
});

describe('loadProjectRegistryCached（T4.5）', () => {
  it('同 registryFile 命中缓存（同一实例）；clear 后重载', async () => {
    const regFile = path.join(tmp, 'projects.json');
    const first = await loadProjectRegistryCached(regFile);
    first.add('demo', path.join(tmp, 'demo'));
    await first.save();

    // 缓存命中 → 同一实例（内存已含 demo，不重复读盘）
    const second = await loadProjectRegistryCached(regFile);
    expect(second).toBe(first);
    expect(second.has('demo')).toBe(true);

    // 磁盘确实落盘（绕过缓存直读）
    const onDisk = await ProjectRegistry.load(regFile);
    expect(onDisk.has('demo')).toBe(true);

    // clear 后重载 → 新实例但内容一致（从磁盘读回）
    clearProjectRegistryCache();
    const reloaded = await loadProjectRegistryCached(regFile);
    expect(reloaded).not.toBe(first);
    expect(reloaded.has('demo')).toBe(true);
  });

  it('不同 registryFile 不共享缓存', async () => {
    const regA = path.join(tmp, 'a.json');
    const regB = path.join(tmp, 'b.json');
    const a = await loadProjectRegistryCached(regA);
    const b = await loadProjectRegistryCached(regB);
    expect(a).not.toBe(b);
  });
});
