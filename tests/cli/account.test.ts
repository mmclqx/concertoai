/**
 * 多账号命令测试（v3.1 M3 / T3.2 + T3.3）。
 *
 * 覆盖：
 * - maskApiKey：sk- 前缀保留、后 4 位、短 Key 全掩码；
 * - runLoginCommand：--key 非交互注入；重名默认拒绝；覆盖确认（y/N 交互由 promptSecret 负责，
 *   命令层返回 '已取消'）；登录后自动 active；
 * - runLogoutCommand：purge=false 保留文件；purge=true 删除；未注册提示；
 * - runWhoamiCommand：显示账号名 + 打码；无 active 提示；指针缺失提示；
 * - runAccountListCommand / runAccountSwitchCommand；
 * - resolveApiKey 优先级：cli > env > active account > config > none；
 * - 安全输出：任意命令输出不含完整 Key（正则断言）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runAccountListCommand,
  runAccountSwitchCommand,
  runLoginCommand,
  runLogoutCommand,
  runWhoamiCommand,
} from '../../src/cli/account';
import { maskApiKey, resolveApiKey } from '../../src/cli/common';
import { getActiveAccount, getApiKeyFor, saveAccount } from '../../src/store/accounts';

let tmp: string;
let root: string;
let logs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'account-cli-'));
  root = path.join(tmp, 'accounts');
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

const KEY = 'sk-secret-abcdefgh';
const out = (): string => logs.join('\n');

describe('maskApiKey（打码）', () => {
  it('sk- 前缀保留 + 后 4 位，中间打码', () => {
    expect(maskApiKey('sk-abcdefgh1234')).toBe('sk-****1234');
  });

  it('非 sk- 前缀 Key 不打前缀（仍打码）', () => {
    expect(maskApiKey('abc-1234567890wxyz')).toBe('****wxyz');
  });

  it('短 Key / 空 Key 全掩码', () => {
    expect(maskApiKey('abcd')).toBe('****');
    expect(maskApiKey('')).toBe('****');
  });
});

describe('runLoginCommand（T3.2）', () => {
  it('--key 非交互注入：创建账号并自动设为 active，输出打码', async () => {
    await runLoginCommand({ name: 'work', key: KEY, accountsRoot: root });
    expect(await getApiKeyFor('work', root)).toBe(KEY);
    expect(await getActiveAccount(root)).toBe('work');
    expect(out()).toContain('✅ 账号 work 已登录');
    expect(out()).toContain(maskApiKey(KEY));
    expect(out()).not.toContain(KEY); // 不泄露完整 Key
  });

  it('重名默认拒绝（覆盖需显式确认，fail-closed）', async () => {
    await runLoginCommand({ name: 'work', key: KEY, accountsRoot: root });
    logs = [];
    // 重名且未确认覆盖（promptSecret 在非 TTY 会退出——这里直接验证 saveAccount 层语义：
    // 命令层对 exists 走交互确认；为可测，先用 overwrite 路径验证）
    await runLoginCommand({ name: 'work', key: 'sk-new-xxxx', accountsRoot: root });
    // 由于非 TTY 无法交互确认，命令走 promptSecret 退出——此处断言原 Key 未被覆盖
    expect(await getApiKeyFor('work', root)).toBe(KEY);
  });
});

describe('runLogoutCommand', () => {
  it('purge=false：清 active 指针，账号文件保留', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    const { setActiveAccount } = await import('../../src/store/accounts');
    await setActiveAccount('work', root);
    await runLogoutCommand({ name: 'work', accountsRoot: root });
    expect(await getActiveAccount(root)).toBeUndefined();
    expect(out()).toContain('已登出');
    expect(out()).toContain('账号文件保留');
    // 文件仍在
    expect(await getApiKeyFor('work', root)).toBe(KEY);
  });

  it('purge=true：删除账号文件', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    await runLogoutCommand({ name: 'work', purge: true, accountsRoot: root });
    expect(out()).toContain('--purge');
    let threw = false;
    try {
      await getApiKeyFor('work', root);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('未注册账号 → 提示未注册', async () => {
    await runLogoutCommand({ name: 'ghost', accountsRoot: root });
    expect(out()).toContain('未注册');
  });
});

describe('runWhoamiCommand', () => {
  it('有 active → 显示账号名 + 打码 Key', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    const { setActiveAccount } = await import('../../src/store/accounts');
    await setActiveAccount('work', root);
    await runWhoamiCommand({ accountsRoot: root });
    expect(out()).toContain('当前账号: work');
    expect(out()).toContain(maskApiKey(KEY));
    expect(out()).not.toContain(KEY);
  });

  it('无 active → 提示未登录', async () => {
    await runWhoamiCommand({ accountsRoot: root });
    expect(out()).toContain('当前未登录');
  });

  it('T4.4 active 指针指向缺失账号 → 给出可复制的修复命令', async () => {
    const { setActiveAccount } = await import('../../src/store/accounts');
    await setActiveAccount('ghost', root);
    await runWhoamiCommand({ accountsRoot: root });
    expect(out()).toContain('ghost');
    expect(out()).toContain('concertoai login ghost');
  });
});

describe('runAccountListCommand / runAccountSwitchCommand', () => {
  it('list：列出账号 + active 标记；空列表提示', async () => {
    await saveAccount('a', KEY, { accountsRoot: root });
    await saveAccount('b', KEY, { accountsRoot: root });
    const { setActiveAccount } = await import('../../src/store/accounts');
    await setActiveAccount('b', root);
    await runAccountListCommand({ accountsRoot: root });
    expect(out()).toContain('a');
    expect(out()).toContain('b ★（当前）');
  });

  it('switch：切换到已存在账号；未登录账号报错', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    await runAccountSwitchCommand({ name: 'work', accountsRoot: root });
    expect(await getActiveAccount(root)).toBe('work');
    expect(out()).toContain('✅ 已切换到账号 work');

    logs = [];
    await runAccountSwitchCommand({ name: 'ghost', accountsRoot: root });
    expect(out()).toContain('未登录');
  });
});

describe('resolveApiKey 优先级（T3.3）', () => {
  it('CLI > env > active account > config > none', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    const { setActiveAccount } = await import('../../src/store/accounts');
    await setActiveAccount('work', root);

    // 仅 active account（envKey: '' 屏蔽真实环境变量）
    const fromAccount = await resolveApiKey({ envKey: '', accountsRoot: root });
    expect(fromAccount).toMatchObject({ key: KEY, source: 'account', accountName: 'work' });

    // env 覆盖 account
    const fromEnv = await resolveApiKey({ envKey: 'sk-env-xxxx', accountsRoot: root });
    expect(fromEnv).toMatchObject({ key: 'sk-env-xxxx', source: 'env' });

    // cli 覆盖 env
    const fromCli = await resolveApiKey({
      cliKey: 'sk-cli-xxxx',
      envKey: 'sk-env-xxxx',
      accountsRoot: root,
    });
    expect(fromCli).toMatchObject({ key: 'sk-cli-xxxx', source: 'cli' });
  });

  it('无任何来源 → source=none, key=undefined', async () => {
    const resolved = await resolveApiKey({ envKey: '', accountsRoot: root });
    expect(resolved).toEqual({ key: undefined, source: 'none' });
  });

  it('active 指针指向缺失账号 → 回退（不抛错）', async () => {
    // 直接写 active 指针指向不存在的账号
    const { setActiveAccount } = await import('../../src/store/accounts');
    await setActiveAccount('ghost', root);
    const resolved = await resolveApiKey({ envKey: '', accountsRoot: root });
    expect(resolved.source).toBe('none');
  });
});

describe('安全输出（完整 Key 永不泄露）', () => {
  it('所有命令输出不含完整 Key（正则断言）', async () => {
    await saveAccount('work', KEY, { accountsRoot: root });
    await runLoginCommand({ name: 'work2', key: KEY, accountsRoot: root });
    await runAccountListCommand({ accountsRoot: root });
    await runWhoamiCommand({ accountsRoot: root });
    const full = out();
    // KEY 完整串不应以原始形式出现
    expect(full).not.toMatch(new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
