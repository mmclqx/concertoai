import { afterEach, describe, expect, it, vi } from 'vitest';

import { priceTierSummary, printBalance, runBalanceCommand } from '../../src/cli/balance';

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

let log: ReturnType<typeof vi.spyOn> | undefined;
let err: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  log?.mockRestore();
  err?.mockRestore();
});

function captureLog(): void {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('printBalance', () => {
  it('成功输出 💰 余额：¥X.XX 格式', () => {
    captureLog();
    printBalance(okBalance);
    const lines = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));
    expect(lines).toEqual(['💰 余额：¥110.00']);
  });

  it('多币种逐行输出（USD 用 $，未知币种用代码前缀）', () => {
    captureLog();
    printBalance({
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '110.00',
          granted_balance: '10.00',
          topped_up_balance: '100.00',
        },
        {
          currency: 'USD',
          total_balance: '5.50',
          granted_balance: '0.00',
          topped_up_balance: '5.50',
        },
        {
          currency: 'JPY',
          total_balance: '3.00',
          granted_balance: '0.00',
          topped_up_balance: '3.00',
        },
      ],
    });
    const lines = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));
    expect(lines).toEqual(['💰 余额：¥110.00', '💰 余额：$5.50', '💰 余额：JPY 3.00']);
  });

  it('账户不可用时输出不可用；无余额信息时输出提示', () => {
    captureLog();
    printBalance({ is_available: false, balance_infos: [] });
    const lines = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));
    expect(lines).toEqual(['账户不可用']);
    log?.mockClear();
    printBalance({ is_available: true, balance_infos: [] });
    const lines2 = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));
    expect(lines2).toEqual(['无余额信息']);
  });
});

describe('priceTierSummary（v5.0 T7：当前时段真实单价）', () => {
  /** 周三 10:00 → 高峰。 */
  const PEAK_AT = new Date(2026, 9, 28, 10, 0, 0);
  /** 周三 20:00 → 空闲。 */
  const OFFPEAK_AT = new Date(2026, 9, 28, 20, 0, 0);

  it('高峰时段标注「高峰价」并给出高峰单价', () => {
    const line = priceTierSummary(PEAK_AT);
    expect(line).toContain('高峰价');
    expect(line).toContain('¥3/百万'); // flash 高峰输入价
    expect(line).toContain('¥9/百万'); // flash 高峰输出价
    expect(line).toContain('缓存命中');
  });

  it('空闲时段标注「空闲价」并给出空闲单价', () => {
    const line = priceTierSummary(OFFPEAK_AT);
    expect(line).toContain('空闲价');
    expect(line).toContain('¥1.5/百万');
    expect(line).toContain('¥4.5/百万');
  });

  it('周末按空闲价展示（不误导用户以为涨价）', () => {
    expect(priceTierSummary(new Date(2026, 9, 31, 10, 0, 0))).toContain('空闲价');
  });

  it('缺省参数取当前时刻（不抛错，且必为两种标注之一）', () => {
    const line = priceTierSummary();
    expect(/高峰价|空闲价/.test(line)).toBe(true);
  });
});

describe('runBalanceCommand', () => {
  it('查询成功返回 0 并输出余额', async () => {
    captureLog();
    const code = await runBalanceCommand({
      apiKey: 'k',
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    const lines = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));
    expect(lines.join('\n')).toContain('💰 余额：¥110.00');
  });

  it('成功时附带当前时段单价（v5.0 T7）', async () => {
    captureLog();
    await runBalanceCommand({
      apiKey: 'k',
      fetchImpl: async () => jsonResponse(okBalance),
      at: new Date(2026, 9, 28, 20, 0, 0), // 周三 20:00 空闲
    });
    const out = (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('空闲价');
    expect(out).toContain('/百万');
  });

  it('查询失败返回 1 且不打印成功输出', async () => {
    captureLog();
    const code = await runBalanceCommand({
      apiKey: 'bad',
      fetchImpl: async () => new Response('{"error":{}}', { status: 401 }),
    });
    expect(code).toBe(1);
    expect(err?.mock.calls.join('\n')).toContain('HTTP 401');
    expect(log?.mock.calls.join('\n')).not.toContain('💰 余额');
  });
});
