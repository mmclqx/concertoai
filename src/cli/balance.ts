/**
 * `concertoai balance` 命令：查询 DeepSeek 账户余额。
 *
 * 调用 DeepSeek 官方余额接口 GET /user/balance，输出各币种
 * 总额 / 赠送 / 充值余额。返回进程退出码（0 = 成功，1 = 查询失败），
 * 由 CLI 入口设置 process.exitCode（便于测试，不在命令内 process.exit）。
 */

import type { DeepSeekBalance } from '../balance';
import { fetchBalance } from '../balance';
import { fmt, t } from '../i18n';

/** balance 命令选项。 */
export interface BalanceCommandOptions {
  /** DeepSeek API Key。 */
  apiKey: string;
  /** API 基础地址（测试注入）。 */
  baseUrl?: string;
  /** fetch 实现（测试注入）。 */
  fetchImpl?: typeof fetch;
}

/** 币种 → 符号映射（¥/$/€/£；未知币种用币种代码 + 空格，如 `JPY 5.00`）。 */
export function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY':
      return '¥';
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    default:
      return `${currency} `;
  }
}

/** 输出余额信息到 stdout（导出以便测试）。成功：`💰 余额：¥X.XX`；不可用/为空输出提示。 */
export function printBalance(balance: DeepSeekBalance): void {
  const dict = t().balance;
  if (!balance.is_available) {
    console.log(dict.unavailable);
    return;
  }
  if (balance.balance_infos.length === 0) {
    console.log(dict.empty);
    return;
  }
  for (const info of balance.balance_infos) {
    console.log(
      fmt(dict.line, { symbol: currencySymbol(info.currency), total: info.total_balance }),
    );
  }
}

/** 执行 balance 命令；返回进程退出码。 */
export async function runBalanceCommand(options: BalanceCommandOptions): Promise<number> {
  try {
    const balance = await fetchBalance(options.apiKey, {
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });
    printBalance(balance);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
