/**
 * CLI 共享模块缓存测试（v3.2 M4 / T4.5：启动期缓存消除重复 I/O）。
 *
 * 覆盖：
 * - resolveApiKeyCached：同 accountsRoot 命中缓存（active 切换后仍返回首次值），clear 后刷新；
 * - 不同 accountsRoot 不共享缓存；
 * - loadProjectRegistryCached：同 registryFile 命中缓存（同一实例），clear 后重载。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearApiKeyCache,
  clearProjectRegistryCache,
  loadProjectRegistryCached,
  resolveApiKeyCached,
} from '../../src/cli/common';
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
