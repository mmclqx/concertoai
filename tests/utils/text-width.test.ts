/**
 * 显示宽度工具测试（v5.0 T9）。
 *
 * 为什么值得单独测：审批卡里**中文 + emoji + diff 前缀**混排，用 `.length` 判断宽度
 * 必然溢出边框（`'超时'.length===2` 但占 4 格；`'⚠️'.length===2` 含 VS16）。
 */

import { describe, expect, it } from 'vitest';

import { displayWidth, ELLIPSIS, stripAnsi, truncateToWidth } from '../../src/utils/text-width';

describe('displayWidth', () => {
  it('ASCII 逐字符算 1', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('const a = 1;')).toBe(12);
    expect(displayWidth('')).toBe(0);
  });

  it('中文/全角算 2（.length 会低估一半）', () => {
    expect('超时'.length).toBe(2);
    expect(displayWidth('超时')).toBe(4);
    expect(displayWidth('风险审批')).toBe(8);
    expect(displayWidth('，')).toBe(2); // 全角逗号
  });

  it('emoji 算 2，VS16 变体选择符算 0（⚠️ 是 2 格不是 3）', () => {
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('⚠️')).toBe(2);
    expect(displayWidth('✅')).toBe(2);
    expect(displayWidth('🟡')).toBe(2);
  });

  it('组合附加符号与零宽字符算 0', () => {
    expect(displayWidth('e\u0301')).toBe(1); // e + 组合重音符
    expect(displayWidth('\u200b')).toBe(0); // 零宽空格
    expect(displayWidth('\uFEFF')).toBe(0); // BOM
  });

  it('控制字符算 0', () => {
    expect(displayWidth('\u0000\u0007\t')).toBe(0);
  });

  it('ANSI 转义序列算 0（diff 上色后行内会有）', () => {
    expect(displayWidth('\u001b[32m+new line\u001b[39m')).toBe(9);
    expect(stripAnsi('\u001b[31m-old\u001b[39m')).toBe('-old');
  });

  it('中英混排正确累加', () => {
    expect(displayWidth('第 42 行（超时）')).toBe(2 + 1 + 2 + 1 + 2 + 2 + 4 + 2);
  });
});

describe('truncateToWidth', () => {
  it('未超宽时原样返回（不改动 diff 前缀）', () => {
    expect(truncateToWidth('+const a = 1;', 40)).toBe('+const a = 1;');
    expect(truncateToWidth('+超时从 5s 改到 10s', 40)).toBe('+超时从 5s 改到 10s');
  });

  it('超宽时截断且结果宽度 ≤ 目标宽度（含省略号）', () => {
    const long = `+${'很长的中文注释'.repeat(12)}`;
    const out = truncateToWidth(long, 30);
    expect(displayWidth(out)).toBeLessThanOrEqual(30);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    expect(out.startsWith('+')).toBe(true);
  });

  it('不会把 emoji/中文切成半个（按码点截断）', () => {
    const out = truncateToWidth('🚀🚀🚀🚀🚀🚀', 7);
    expect(displayWidth(out)).toBeLessThanOrEqual(7);
    // 不能出现「半个 emoji」导致的孤立代理项
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('宽度为 0/负数返回空串（窄终端不崩）', () => {
    expect(truncateToWidth('abc', 0)).toBe('');
    expect(truncateToWidth('abc', -5)).toBe('');
    expect(truncateToWidth('abc', 1)).toBe(ELLIPSIS);
  });

  it('恰好等于宽度时不截断', () => {
    expect(truncateToWidth('超时', 4)).toBe('超时');
    expect(truncateToWidth('超时了', 4)).toBe(`超${ELLIPSIS}`);
  });
});
