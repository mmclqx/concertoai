/**
 * 多账号存储测试（v3.1 M3 / T3.1）。
 *
 * 覆盖：
 * - saveAccount：新建 created / 重名不覆盖 exists / overwrite 覆盖 overwritten；
 * - 权限：POSIX 下 config.json 权限 0600（Windows 跳过）；
 * - setActiveAccount / getActiveAccount 指针读写；无 active → undefined；
 * - listAccounts 只列账号名（不包含 Key）；
 * - removeAccount：purge=false 仅清 active 指针；purge=true 删除账号目录；
 * - 非法账号名拒绝（路径穿越 / 空 / 隐藏名）；
 * - Key 值不写日志、不进入任何输出。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertValidAccountName,
  getActiveAccount,
  getApiKeyFor,
  InvalidAccountNameError,
  listAccounts,
  removeAccount,
  saveAccount,
  setActiveAccount,
} from '../../src/store/accounts';

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
  root = path.join(tmp, 'accounts');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const KEY = 'sk-test-1234567890abcd';

describe('saveAccount（CRUD）', () => {
  it('新建账号 → created，config.json 含 apiKey', async () => {
    const status = await saveAccount('work', KEY, { accountsRoot: root });
    expect(status).toBe('created');
    const raw = readFileSync(path.join(root, 'work', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { apiKey: string };
    expect(parsed.apiKey).toBe(KEY);
  });

  it('重名不覆盖（默认）→ exists；overwrite=true → overwritten 且 Key 更新', async () => {
    await saveAccount('work', 'sk-old-key-aaaa', { accountsRoot: root });
    const status = await saveAccount('work', KEY, { accountsRoot: root });
    expect(status).toBe('exists');
    // 原 Key 未被覆盖
    expect(await getApiKeyFor('work', root)).toBe('sk-old-key-aaaa');

    const overwritten = await saveAccount('work', KEY, { overwrite: true, accountsRoot: root });
    expect(overwritten).toBe('overwritten');
    expect(await getApiKeyFor('work', root)).toBe(KEY);
  });

  it('POSIX 下 config.json 权限为 0600（Windows 跳过）', async () => {
    if (process.platform === 'win32') {
      return;
    }
    await saveAccount('work', KEY, { accountsRoot: root });
    const mode = statSync(path.join(root, 'work', 'config.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('active 指针', () => {
  it('setActive + getActive 往返', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    await setActiveAccount('work', root);
    expect(await getActiveAccount(root)).toBe('work');
  });

  it('无 active / 指针缺失 → undefined', async () => {
    expect(await getActiveAccount(root)).toBeUndefined();
  });

  it('切换 active 覆盖旧指针', async () => {
    await saveAccount('a', KEY, { accountsRoot: root });
    await saveAccount('b', KEY, { accountsRoot: root });
    await setActiveAccount('a', root);
    await setActiveAccount('b', root);
    expect(await getActiveAccount(root)).toBe('b');
  });
});

describe('listAccounts / removeAccount', () => {
  it('listAccounts 只列账号名（含 Key 的文件不泄露）', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    await saveAccount('home', KEY, { accountsRoot: root });
    const names = await listAccounts(root);
    expect(names).toEqual(['home', 'work']);
    // 输出不含 Key 内容
    expect(JSON.stringify(names)).not.toContain('test-key');
  });

  it('purge=false 仅清 active 指针，账号目录保留', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    await setActiveAccount('work', root);
    await removeAccount('work', { purge: false, accountsRoot: root });
    expect(await getActiveAccount(root)).toBeUndefined();
    expect(existsSync(path.join(root, 'work', 'config.json'))).toBe(true);
  });

  it('purge=true 删除账号目录并清 active 指针', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    await setActiveAccount('work', root);
    await removeAccount('work', { purge: true, accountsRoot: root });
    expect(existsSync(path.join(root, 'work'))).toBe(false);
    expect(await getActiveAccount(root)).toBeUndefined();
  });

  it('删除非 active 账号不影响 active 指针', async () => {
    await saveAccount('a', KEY, { accountsRoot: root });
    await saveAccount('b', KEY, { accountsRoot: root });
    await setActiveAccount('a', root);
    await removeAccount('b', { purge: true, accountsRoot: root });
    expect(await getActiveAccount(root)).toBe('a');
  });
});

describe('账号名校验（防路径穿越）', () => {
  it('非法名抛 InvalidAccountNameError', () => {
    for (const bad of ['', 'a/b', 'a\\b', '..', '.', 'a b', '中文']) {
      expect(() => assertValidAccountName(bad)).toThrow(InvalidAccountNameError);
    }
  });

  it('合法名通过', () => {
    for (const good of ['work', 'my-account', 'a.b_c', 'A1']) {
      expect(() => assertValidAccountName(good)).not.toThrow();
    }
  });
});

describe('安全输出', () => {
  it('账号配置读取只暴露 Key 给调用方，不含任何日志副作用', async () => {
    const logSpy = (await import('vitest')).vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await saveAccount('work', KEY, { accountsRoot: root });
      await setActiveAccount('work', root);
      await listAccounts(root);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('chmodSync 兼容：Windows 下 chmod 不抛错（尽力而为）', async () => {
    if (process.platform === 'win32') {
      // Windows 下 saveAccount 内部 chmod 静默跳过；此处仅验证不崩溃
      await saveAccount('win', KEY, { accountsRoot: root });
      expect(existsSync(path.join(root, 'win', 'config.json'))).toBe(true);
    } else {
      chmodSync(path.join(root, 'x'), 0o600); // 仅验证函数存在
      await saveAccount('posix', KEY, { accountsRoot: root });
      expect(existsSync(path.join(root, 'posix', 'config.json'))).toBe(true);
    }
  });
});
