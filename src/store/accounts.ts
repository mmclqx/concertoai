/**
 * 多账号存储（v3.1 M3 / T3.1）：~/.concertoai/accounts/。
 *
 * 账号 = 一个 DeepSeek API Key 配置文件（git credential 模式），与项目无关：
 * - `~/.concertoai/accounts/<name>/config.json`：{ apiKey }（POSIX 权限 0600）；
 * - `~/.concertoai/accounts/active-account`：当前 active 账号名（纯文本指针）。
 *
 * 安全约定：
 * - Key 值不写日志、不进入审计输出（本模块不产生任何日志）；
 * - `listAccounts()` 只返回账号名，不包含 Key；
 * - `getApiKeyFor(name)` 仅在被调用方需要时读取（如 getApiKey 解析链）。
 */

import type { Dirent } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { accountConfigPath, activeAccountPath } from './paths';

/** 账号名允许的字符集（防路径穿越，与项目名一致）。 */
const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** 账号配置文件结构。 */
export interface AccountConfig {
  apiKey: string;
}

/** saveAccount 结果状态。 */
export type SaveAccountStatus = 'created' | 'overwritten' | 'exists';

/** saveAccount 选项。 */
export interface SaveAccountOptions {
  /** 是否允许覆盖已存在账号（重名覆盖前需调用方显式确认）。 */
  overwrite?: boolean;
  /** accounts 根目录（测试注入；默认 ~/.concertoai/accounts）。 */
  accountsRoot?: string;
}

/** 账号已存在且未允许覆盖。 */
export class AccountAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`账号 ${name} 已存在（如需覆盖请显式确认）`);
    this.name = 'AccountAlreadyExistsError';
  }
}

/** 非法账号名。 */
export class InvalidAccountNameError extends Error {
  constructor(name: string) {
    super(`非法账号名: ${name}（只允许字母/数字/._-）`);
    this.name = 'InvalidAccountNameError';
  }
}

/** 校验账号名（拒绝空 / 路径穿越 / 隐藏名）。 */
export function assertValidAccountName(name: string): void {
  if (!ACCOUNT_NAME_RE.test(name) || name === '.' || name === '..') {
    throw new InvalidAccountNameError(name);
  }
}

/**
 * 保存账号：写入 ~/.concertoai/accounts/<name>/config.json。
 * - POSIX 下设置文件权限 0600（仅所有者读写）；Windows 尽力而为跳过不报错；
 * - 重名时按 overwrite 决定：false（默认）→ 返回 'exists'；true → 覆盖并返回 'overwritten'；
 * - 新建返回 'created'。
 */
export async function saveAccount(
  name: string,
  apiKey: string,
  options: SaveAccountOptions = {},
): Promise<SaveAccountStatus> {
  assertValidAccountName(name);
  const file =
    options.accountsRoot !== undefined
      ? path.join(options.accountsRoot, name, 'config.json')
      : accountConfigPath(name);
  let existed = false;
  try {
    await stat(file);
    existed = true;
  } catch {
    existed = false;
  }
  if (existed && options.overwrite !== true) {
    return 'exists';
  }
  await mkdir(path.dirname(file), { recursive: true });
  // 原子写：临时文件 + rename（避免半写状态泄露 Key）
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ apiKey } satisfies AccountConfig, null, 2)}\n`, 'utf8');
  // POSIX 0600：仅非 Windows 平台执行（Windows 权限模型无 0600 语义，避免无意义调用）
  if (process.platform !== 'win32') {
    try {
      await chmod(tmp, 0o600);
    } catch {
      // 文件系统不支持权限位（如部分网络盘）时跳过，不阻塞保存
    }
  }
  await import('node:fs/promises').then(({ rename }) => rename(tmp, file));
  return existed ? 'overwritten' : 'created';
}

/** 读取账号 Key；账号不存在抛 ENOENT（由调用方处理）。 */
export async function getApiKeyFor(name: string, accountsRoot?: string): Promise<string> {
  const file =
    accountsRoot !== undefined
      ? path.join(accountsRoot, name, 'config.json')
      : accountConfigPath(name);
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as Partial<AccountConfig>;
  const key = parsed.apiKey;
  if (typeof key !== 'string' || key === '') {
    throw new Error(`账号 ${name} 配置缺少有效 apiKey`);
  }
  return key;
}

/** 设置 active 账号指针（写纯文本；不存在账号也允许设置，由调用方校验）。 */
export async function setActiveAccount(name: string, accountsRoot?: string): Promise<void> {
  assertValidAccountName(name);
  const file =
    accountsRoot !== undefined ? path.join(accountsRoot, 'active-account') : activeAccountPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${name}\n`, 'utf8');
  await import('node:fs/promises').then(({ rename }) => rename(tmp, file));
}

/** 读取 active 账号名；无 active / 指针损坏 → undefined。 */
export async function getActiveAccount(accountsRoot?: string): Promise<string | undefined> {
  const file =
    accountsRoot !== undefined ? path.join(accountsRoot, 'active-account') : activeAccountPath();
  try {
    const raw = await readFile(file, 'utf8');
    const name = raw.trim();
    if (name === '') {
      return undefined;
    }
    // 宽松读取：指针指向不存在的账号也返回（调用方按需校验）
    return name;
  } catch {
    return undefined;
  }
}

/** 列出全部账号名（不包含 Key），按字典序排序。 */
export async function listAccounts(accountsRoot?: string): Promise<string[]> {
  const root = accountsRoot ?? (await import('./paths')).accountsDir();
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && ACCOUNT_NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * 删除账号：
 * - purge=false（默认）：仅清除 active 指针（若指向该账号），不删除账号目录；
 * - purge=true：删除账号目录（含 config.json），并清除 active 指针。
 */
export async function removeAccount(
  name: string,
  options: { purge?: boolean; accountsRoot?: string } = {},
): Promise<void> {
  assertValidAccountName(name);
  const root = options.accountsRoot ?? (await import('./paths')).accountsDir();
  const dir = path.join(root, name);
  if (options.purge === true) {
    await rm(dir, { recursive: true, force: true });
  }
  const active = await getActiveAccount(options.accountsRoot);
  if (active === name) {
    const file =
      options.accountsRoot !== undefined
        ? path.join(options.accountsRoot, 'active-account')
        : activeAccountPath();
    await rm(file, { force: true });
  }
}
