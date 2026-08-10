/**
 * DeepSeek 账户余额查询。
 *
 * 调用 DeepSeek 官方余额接口：GET {baseUrl}/user/balance
 * （https://api-docs.deepseek.com/zh-cn/api/get-user-balance）
 *
 * 设计要点：
 * - 余额为字符串（官方返回，避免精度问题），不做数值转换；
 * - 超时覆盖到响应返回（默认 15s），超时抛普通 Error；
 * - 非 2xx 抛 BalanceError（含 HTTP 状态码与响应体）；
 * - 单次请求不重试（余额查询是轻量只读 GET，失败让调用方决定）。
 */

import { DEEPSEEK_BASE_URL } from '../model/client';

/** 单个币种的余额信息（官方字段，金额均为字符串）。 */
export interface BalanceInfo {
  /** 币种（如 CNY / USD）。 */
  currency: string;
  /** 账户总余额。 */
  total_balance: string;
  /** 赠送余额。 */
  granted_balance: string;
  /** 充值余额。 */
  topped_up_balance: string;
}

/** GET /user/balance 的响应体。 */
export interface DeepSeekBalance {
  /** 账户是否可用。 */
  is_available: boolean;
  /** 各币种余额列表（通常为单元素）。 */
  balance_infos: BalanceInfo[];
}

/** fetchBalance 选项（测试可注入 baseUrl / fetchImpl）。 */
export interface FetchBalanceOptions {
  /** API 基础地址（默认 DeepSeek 官方）。 */
  baseUrl?: string;
  /** 超时毫秒数（默认 15_000）。 */
  timeoutMs?: number;
  /** 测试注入点。默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
}

/** 余额查询失败（非 2xx）。 */
export class BalanceError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`DeepSeek 余额查询失败（HTTP ${status}）: ${body}`);
    this.name = 'BalanceError';
    this.status = status;
    this.body = body;
  }
}

/** 查询 DeepSeek 账户余额。 */
export async function fetchBalance(
  apiKey: string,
  options: FetchBalanceOptions = {},
): Promise<DeepSeekBalance> {
  const baseUrl = options.baseUrl ?? DEEPSEEK_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`余额查询超时（${timeoutMs}ms）`)),
    timeoutMs,
  );
  try {
    const response = await fetchImpl(`${baseUrl}/user/balance`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new BalanceError(response.status, body);
    }
    return (await response.json()) as DeepSeekBalance;
  } finally {
    clearTimeout(timer);
  }
}
