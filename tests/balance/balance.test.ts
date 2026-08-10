import { describe, expect, it, vi } from 'vitest';

import { fetchBalance } from '../../src/balance';

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return (input, init) => handler(String(input), init ?? {});
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBalance = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

describe('fetchBalance', () => {
  it('发送 GET /user/balance 并解析余额', async () => {
    const fetchImpl = vi.fn(fakeFetch(async () => jsonResponse(okBalance)));
    const balance = await fetchBalance('secret', { fetchImpl });

    const firstCall = fetchImpl.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('测试夹具：fetch 未被调用');
    }
    const [url, init] = firstCall;
    if (init === undefined) {
      throw new Error('测试夹具：fetch 未传入 init');
    }
    expect(url).toBe('https://api.deepseek.com/user/balance');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer secret',
      Accept: 'application/json',
    });
    expect(balance).toEqual(okBalance);
  });

  it('自定义 baseUrl 生效', async () => {
    const fetchImpl = vi.fn(fakeFetch(async () => jsonResponse(okBalance)));
    await fetchBalance('k', { baseUrl: 'https://example.com/v1', fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.com/v1/user/balance');
  });

  it('非 2xx 抛 BalanceError（带状态码与响应体）', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(
        async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
      ),
    );
    await expect(fetchBalance('bad', { fetchImpl })).rejects.toMatchObject({
      name: 'BalanceError',
      status: 401,
      body: '{"error":{"message":"invalid api key"}}',
    });
  });

  it('超时抛错并中止请求', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    await expect(fetchBalance('k', { timeoutMs: 20, fetchImpl })).rejects.toThrow('余额查询超时');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('账户不可用与空余额列表原样返回', async () => {
    const fetchImpl = vi.fn(
      fakeFetch(async () => jsonResponse({ is_available: false, balance_infos: [] })),
    );
    const balance = await fetchBalance('k', { fetchImpl });
    expect(balance.is_available).toBe(false);
    expect(balance.balance_infos).toEqual([]);
  });
});
