/**
 * 成本回执行渲染（K15）单测。
 *
 * ## 为什么单独测这一行
 *
 * 三个花钱动词（`review` / `commit` / `fix`）共用这一份格式化，而它要同时满足两个
 * 互相拉扯的要求：
 * - **人要看懂**：调用次数 + token + 金额，一行说完；
 * - **脚本要解析**：`scripts/lib/cost-gate.mjs` 靠这行判熔断，
 *   金额必须是 `¥` + 纯数字（带 `≈` 没关系，带千分位逗号就有关系了）。
 *
 * 还有第三条更重要的：**量不到时说「未统计」，而不是 ¥0**。
 * 打印 `¥0.000000` 会让用户（和脚本）以为这次没花钱 —— 那正是 K15 的病根。
 */

import { describe, expect, it } from 'vitest';

import { formatCny, formatUsageLine } from '../../src/cli/usage-line';
import { zh } from '../../src/i18n/zh';
import { emptyUsageTotals, type UsageTotals } from '../../src/model/usage-tally';

/** 构造一份「量到了」的快照。 */
function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    ...emptyUsageTotals(),
    calls: 6,
    input: 8123,
    output: 941,
    cacheHit: 4096,
    cost: 0.0129,
    measured: true,
    ...overrides,
  };
}

describe('formatCny', () => {
  it('≥ ¥0.01 保留 4 位', () => {
    expect(formatCny(0.0129)).toBe('0.0129');
    expect(formatCny(2.11)).toBe('2.1100');
  });

  it('小额保留 6 位，不显示成 0.0000', () => {
    expect(formatCny(0.00019)).toBe('0.000190');
    expect(formatCny(0.0000004)).toBe('0.000000');
  });

  it('NaN / 负数 → 0（不许把脏数渲染成金额）', () => {
    expect(formatCny(Number.NaN)).toBe('0.000000');
    expect(formatCny(-1)).toBe('0.000000');
  });
});

describe('formatUsageLine', () => {
  it('量到了、全可计价 → 一行含调用次数 / token / 缓存命中 / 金额', () => {
    const line = formatUsageLine(totals(), zh.usage);
    expect(line).toContain('6 次调用');
    expect(line).toContain('输入 8123');
    expect(line).toContain('输出 941');
    expect(line).toContain('缓存命中 4096');
    expect(line).toContain('¥0.0129');
  });

  it('输出的金额可被脚本闸门解析（与 cost-gate 的判据同形）', () => {
    const line = formatUsageLine(totals(), zh.usage);
    // 与 scripts/lib/cost-gate.mjs 的 COST_LINE_PATTERN 同一条判据（此处重复一份是为了
    // 让「产品输出」与「脚本判据」在同一处被看见；真正的单一来源是脚本那份）
    const match = /本次消耗[^\n]*?¥\s*([0-9]+(?:\.[0-9]+)?)/.exec(line);
    expect(match?.[1]).toBe('0.0129');
  });

  it('★ 量不到（measured=false）→ 明说「未能统计」，绝不出现 ¥0', () => {
    const line = formatUsageLine({ ...emptyUsageTotals() }, zh.usage);
    expect(line).toContain('未能统计');
    expect(line).not.toContain('¥0');
  });

  it('★ 客户端不上报 usage（undefined）→ 同一句「未能统计」', () => {
    const line = formatUsageLine(undefined, zh.usage);
    expect(line).toContain('未能统计');
    expect(line).not.toContain('¥0');
  });

  it('含未定价模型 → 金额注明只是可计价部分，并点名模型', () => {
    const line = formatUsageLine(
      totals({ priced: false, unknownModels: ['custom-model'], cost: 0 }),
      zh.usage,
    );
    expect(line).toContain('custom-model');
    expect(line).toContain('未计价');
  });

  it('零花费但真的量到了（例如全缓存命中）→ 打 ¥0 是诚实的（与「未统计」不同）', () => {
    const line = formatUsageLine(
      totals({ input: 0, output: 0, cacheHit: 0, cost: 0, calls: 1 }),
      zh.usage,
    );
    expect(line).toContain('¥0.000000');
    expect(line).not.toContain('未能统计');
  });

  /**
   * K14：自定义端点（企业代理 / 自建中转 / Ollama 网关）的真实计费口径我们不知道。
   *
   * 这时仍打出 `≈ ¥0.0129` 会被读成**账单**——而它只是「把 token 数乘以
   * DeepSeek 公开价」。所以量到了也必须加一句「非账单」，否则 K15 修好的
   * 「诚实成本」在自定义端点下又变成一句假话。
   */
  it('★ 自定义端点：量到了也要说清「按公开价估算，非账单」', () => {
    const line = formatUsageLine(totals(), zh.usage, { customEndpoint: true });
    expect(line).toContain('¥0.0129');
    expect(line).toContain(zh.usage.endpointNote.trim());
    expect(line).toContain('非账单');
  });

  it('官方端点（缺省）不出现那句标注——不给绝大多数用户添噪音', () => {
    expect(formatUsageLine(totals(), zh.usage)).not.toContain('非账单');
    expect(formatUsageLine(totals(), zh.usage, { customEndpoint: false })).not.toContain('非账单');
  });

  it('自定义端点 + 未计价模型 → 两种实话都在（金额既是下限、也不是账单）', () => {
    const line = formatUsageLine(
      totals({ priced: false, unknownModels: ['custom-model'], cost: 0 }),
      zh.usage,
      { customEndpoint: true },
    );
    expect(line).toContain('未计价');
    expect(line).toContain('非账单');
  });

  it('自定义端点 + 量不到 → 仍是「未能统计」，不因端点不同而改口', () => {
    const line = formatUsageLine(undefined, zh.usage, { customEndpoint: true });
    expect(line).toContain('未能统计');
    expect(line).not.toContain('¥0');
  });
});
