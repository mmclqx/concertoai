/**
 * 多账号命令（v3.1 M3 / T3.2）：
 * - `concertoai login <name> [--key <key>]`：登录（交互输入 Key 不回显；--key 非交互注入）；
 * - `concertoai logout <name> [--purge]`：登出（清除 active 指针；--purge 删除账号目录）；
 * - `concertoai whoami`：显示当前账号名 + Key 后 4 位（打码 sk-****abcd）；
 * - `concertoai account switch <name>`：切换 active；
 * - `concertoai account list`：表格列出账号与 active 标记。
 *
 * 安全约定：任意命令输出不包含完整 Key（测试断言）。
 */

import readline from 'node:readline';

import {
  getActiveAccount,
  getApiKeyFor,
  listAccounts,
  removeAccount,
  saveAccount,
  setActiveAccount,
} from '../store/accounts';
import type { AccountCommandOptions } from './account-types';
import { maskApiKey } from './common';

export type { AccountCommandOptions } from './account-types';

export { maskApiKey } from './common';

/** 交互输入 Key（不回显）：readline 拦截输出，输入字符显示掩码。 */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY !== true) {
      console.error('需要交互式终端输入 API Key；非交互场景请用 --key <key>。');
      resolve('');
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    // 拦截 readline 输出：问题提示正常显示，用户输入字符显示为 *
    // 说明：readline.Interface 实例上无 output 属性（类型定义中 output 仅作
    // createInterface 选项），创建 rl 时已传 output: process.stdout，直接用它。
    const originalWrite = process.stdout.write.bind(process.stdout);
    // 拦截 readline 内部输出（提示正常显示、输入字符掩码）
    (rl as unknown as { _writeToOutput: (str: string) => void })._writeToOutput = (
      str: string,
    ): void => {
      if (str.includes(question)) {
        originalWrite(str);
      } else {
        originalWrite('*');
      }
    };
    rl.question(question, (answer) => {
      originalWrite('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * `concertoai login <name> [--key <key>]`。
 * 重名时交互确认是否覆盖（y/n，fail-closed）。
 */
export async function runLoginCommand(options: AccountCommandOptions): Promise<void> {
  const name = options.name ?? '';
  let key = options.key;
  if (key === undefined || key === '') {
    key = await promptSecret(`请输入 ${name} 的 API Key（输入不回显）: `);
  }
  if (key === undefined || key === '') {
    console.error('❌ API Key 不能为空。');
    return;
  }
  const status = await saveAccount(name, key, {
    overwrite: false,
    accountsRoot: options.accountsRoot,
  });
  if (status === 'exists') {
    // 重名覆盖需显式确认
    const answer = await promptSecret(`账号 ${name} 已存在，覆盖原 Key？(y/N): `);
    if (answer.toLowerCase() !== 'y') {
      console.log('已取消，未覆盖。');
      return;
    }
    await saveAccount(name, key, {
      overwrite: true,
      accountsRoot: options.accountsRoot,
    });
    console.log(`✅ 账号 ${name} 已覆盖（${maskApiKey(key)}）`);
  } else {
    console.log(`✅ 账号 ${name} 已登录（${maskApiKey(key)}）`);
  }
  // 登录后自动设为 active（单一 active 语义）
  await setActiveAccount(name, options.accountsRoot);
}

/**
 * `concertoai logout <name> [--purge]`。
 * 清除 active 指针；提示不删除账号文件，除非 --purge。
 */
export async function runLogoutCommand(options: AccountCommandOptions): Promise<void> {
  const name = options.name ?? '';
  const existed = (await listAccounts(options.accountsRoot)).includes(name);
  if (!existed) {
    console.log(`账号 ${name} 未注册。`);
    return;
  }
  await removeAccount(name, { purge: options.purge === true, accountsRoot: options.accountsRoot });
  if (options.purge === true) {
    console.log(`🗑️ 账号 ${name} 已登出并删除账号文件（--purge）。`);
  } else {
    console.log(`👋 账号 ${name} 已登出（账号文件保留；如需删除请加 --purge）。`);
  }
}

/** `concertoai whoami`：显示当前账号名 + Key 后 4 位（打码）；无 active 时提示。 */
export async function runWhoamiCommand(options: AccountCommandOptions): Promise<void> {
  const active = await getActiveAccount(options.accountsRoot);
  if (active === undefined) {
    console.log('当前未登录任何账号（无 active）。请运行 `concertoai login <name>`。');
    return;
  }
  try {
    const key = await getApiKeyFor(active, options.accountsRoot);
    console.log(`当前账号: ${active}（${maskApiKey(key)}）`);
  } catch {
    console.log(`当前账号指针: ${active}（但账号配置缺失，请重新 login）`);
  }
}

/** `concertoai account list`：表格列出账号与 active 标记。 */
export async function runAccountListCommand(options: AccountCommandOptions): Promise<void> {
  const accounts = await listAccounts(options.accountsRoot);
  const active = await getActiveAccount(options.accountsRoot);
  if (accounts.length === 0) {
    console.log('暂无已登录账号。');
    return;
  }
  console.log('已登录账号：');
  for (const name of accounts) {
    const marker = name === active ? ' ★（当前）' : '';
    console.log(`  ${name}${marker}`);
  }
  if (active !== undefined && !accounts.includes(active)) {
    console.log(`  ${active} ★（当前，但账号文件缺失）`);
  }
}

/** `concertoai account switch <name>`：切换 active（账号必须已存在）。 */
export async function runAccountSwitchCommand(options: AccountCommandOptions): Promise<void> {
  const name = options.name ?? '';
  const existed = (await listAccounts(options.accountsRoot)).includes(name);
  if (!existed) {
    console.log(`❌ 账号 ${name} 未登录。请先运行 \`concertoai login ${name}\`。`);
    return;
  }
  await setActiveAccount(name, options.accountsRoot);
  console.log(`✅ 已切换到账号 ${name}`);
}
