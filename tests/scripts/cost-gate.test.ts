/**
 * 成本闸门（K15 修法 ③）单测：**不花一分钱**证明「闸门有牙」。
 *
 * ## 这组用例存在的唯一理由
 *
 * K15 的事故形态是「闸门安静地失效」：脚本以「跑前余额 − 跑后余额」当判据，
 * 而余额只有 2 位小数 + 结算延迟 → 实测花 ¥2.11 仍打印「差 0」，
 * 「单场景超 ¥1 立刻停」**从头到尾没响过**，却没人收到任何报错。
 *
 * 所以判据在这里被拆成两条**必须能失败**的断言：
 * 1. 超阈值 → `stop: true`（有牙）；
 * 2. **读不到花费 → 也 `stop: true`**（fail-closed：不可度量 ≠ 没花钱）。
 *
 * 闸门纯函数化还解决了另一个问题：以前要验证闸门必须真 Key + 真花钱 + 真跑 CLI，
 * 于是「有没有牙」只能靠人相信；现在注入数值即可，`npm test` 每次都会重跑。
 */

import { describe, expect, it } from 'vitest';

import { gateDecision, parseCostLine, totalGateDecision } from '../../scripts/lib/cost-gate.mjs';
// 文案护栏要用真字典：闸门识别「未计价」这三个字，文案改了这里必须一起改
import { zh } from '../../src/i18n/zh';

// ── 解析成本行 ────────────────────────────────────────────────

describe('parseCostLine', () => {
  it('解析中文成本行（真 Key 脚本里 `review` 的输出形状）', () => {
    const parsed = parseCostLine(
      '💾 报告已保存\n💰 本次消耗：6 次调用 ｜ 输入 8123 / 输出 941 tokens（缓存命中 4096）≈ ¥0.0129\n',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.cost).toBeCloseTo(0.0129, 6);
    }
  });

  it('小额（6 位小数）不被截断成 0（余额口径看不见的量级必须能判）', () => {
    const parsed = parseCostLine('💰 本次消耗：1 次调用 ｜ 输入 100 / 输出 20 tokens ≈ ¥0.000190');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.cost).toBeGreaterThan(0);
      expect(parsed.cost).toBeCloseTo(0.00019, 8);
    }
  });

  /**
   * 未计价模型 → 按「读不到」处理（fail-closed）。
   *
   * 理由：那个金额只是**下限**（不在价格表里的模型没算钱），
   * 放它过闸门等于「花了但可能看不见」——正是 K15 的病。
   */
  it('未计价模型行 → ok:false（金额只是下限，不许当读数）', () => {
    const parsed = parseCostLine(
      '💰 本次消耗：1 次调用 ｜ 输入 10 / 输出 2 tokens ≈ ¥0.000000（x 不在价格表里，这部分未计价）',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('未计价');
    }
  });

  /**
   * 文案护栏：`scripts/lib/cost-gate.mjs` 靠「未计价」三个字识别上面那种行。
   * 中文文案一改（比如改成「未计费」），识别就会静默失配 → 下限值重新变成读数。
   * 所以这里把「字典里必须有这三个字」写成断言：改文案会红，不会静默。
   */
  it('护栏：zh 字典的 unpriced 文案必须含「未计价」（改文案必须来改这里）', () => {
    expect(zh.usage.unpriced).toContain('未计价');
  });

  /**
   * PTY 折行：真 Key 复验走 PTY（`cols: 120`），一行被终端折成两行时
   * 金额会掉到下一行。只看单行 → 读不到 → 闸门 fail-closed 停手
   * （方向安全，但会把「其实量到了」误判成「量不到」，白白中断手工测试）。
   */
  it('PTY 折行：金额掉到下一行仍能读到（真 Key 复验的实际输出形状）', () => {
    const wrapped = [
      '💰 本次消耗：6 次调用 ｜ 输入 8123 / 输出 941 tokens（缓存命中 4096）',
      '≈ ¥0.0129',
      '✅ 已提交。',
    ].join('\n');
    const parsed = parseCostLine(wrapped);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.cost).toBeCloseTo(0.0129, 6);
    }
  });

  it('折行兜底有界：锚点行之后第 4 行往外的 ¥ 不算本次花费', () => {
    const farAway = [
      '💰 本次消耗：6 次调用 ｜ 输入 8123 / 输出 941 tokens',
      '（这一行没有金额）',
      '（这一行也没有）',
      '（这一行也没有）',
      '余额剩余 ≈ ¥7.64',
    ].join('\n');
    expect(parseCostLine(farAway).ok).toBe(false);
  });

  it('输出里没有成本行 → ok:false（绝不兜底成 0）', () => {
    const parsed = parseCostLine(
      '✅ 已提交。\nℹ️  只做了本地提交，本次操作没有推送到任何远程仓库。',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('未找到');
    }
  });

  it('空输入 / 非字符串 → ok:false', () => {
    expect(parseCostLine('').ok).toBe(false);
    expect(parseCostLine('   \n  ').ok).toBe(false);
    // 老版本 dist 完全可能不带这行；也防止有人传进来 undefined
    expect(parseCostLine(undefined as unknown as string).ok).toBe(false);
  });

  it('成本行为「未统计」时 → ok:false（不可度量必须与「花了 0 元」区分开）', () => {
    const parsed = parseCostLine('ℹ️  本次未能统计消耗（当前客户端不上报 usage），费用未知。');
    expect(parsed.ok).toBe(false);
  });
});

// ── 单场景闸门 ────────────────────────────────────────────────

describe('gateDecision（单场景）', () => {
  it('未超阈值 → 继续', () => {
    const decision = gateDecision({ measured: true, cost: 0.59 }, 1, '场景 6');
    expect(decision.stop).toBe(false);
    expect(decision.reason).toContain('未超阈值');
  });

  it('刚好等于阈值 → 继续（判据是「超」而不是「达到」）', () => {
    expect(gateDecision({ measured: true, cost: 1 }, 1).stop).toBe(false);
  });

  it('超阈值 → 停手（这就是 K15 里从未触发过的那条）', () => {
    const decision = gateDecision({ measured: true, cost: 2.11 }, 1, '场景 7');
    expect(decision.stop).toBe(true);
    expect(decision.cost).toBeCloseTo(2.11, 6);
    expect(decision.reason).toContain('超阈值');
  });

  it('★ fail-closed：读不到消耗 → 停手（不可度量不许当「没花钱」）', () => {
    for (const reading of [
      { measured: false },
      { measured: false, cost: 0 },
      { measured: true, cost: Number.NaN },
      { measured: true, cost: Number.POSITIVE_INFINITY },
      undefined,
      null,
    ]) {
      const decision = gateDecision(reading as never, 1, '场景 6');
      expect(decision.stop, `读不到却继续：${JSON.stringify(reading)}`).toBe(true);
      expect(decision.reason).toContain('读不到');
    }
  });

  it('探针通电：把阈值注入成极小值，同一读数必须从「继续」翻成「停」', () => {
    const reading = { measured: true, cost: 0.0002 };
    expect(gateDecision(reading, 1).stop).toBe(false);
    expect(gateDecision(reading, 0.0001).stop).toBe(true);
  });
});

// ── 累计闸门 ──────────────────────────────────────────────────

describe('totalGateDecision（全程预算）', () => {
  it('各场景都不超标、总和也不超标 → 继续', () => {
    const decision = totalGateDecision(
      [
        { measured: true, cost: 0.3 },
        { measured: true, cost: 0.4 },
      ],
      1,
    );
    expect(decision.stop).toBe(false);
    expect(decision.total).toBeCloseTo(0.7, 6);
  });

  it('单场景都不超标但总和超标 → 停手（10 × ¥0.9 = ¥9 的病）', () => {
    const readings = Array.from({ length: 10 }, () => ({ measured: true, cost: 0.9 }));
    expect(totalGateDecision(readings, 5).stop).toBe(true);
  });

  it('任一场景读不到 → 停手并说明', () => {
    const decision = totalGateDecision([{ measured: true, cost: 0.1 }, { measured: false }], 5);
    expect(decision.stop).toBe(true);
    expect(decision.reason).toContain('读不到');
  });

  it('空列表 → 总额 0、不拦（没跑场景不等于超支）', () => {
    const decision = totalGateDecision([], 1);
    expect(decision.stop).toBe(false);
    expect(decision.total).toBe(0);
  });
});
