/**
 * 工具链错误摘要 + 截断工具测试（v4.1 T1.1）。
 *
 * 覆盖：tsc / biome / npm / vitest 四类摘要提取 + ANSI 剥离 + 兜底首行；
 * truncateMiddle 截断边界（短文本原样 / 超长保留头尾标注 / 标注计入长度）。
 */

import { describe, expect, it } from 'vitest';

import { extractErrorSummary } from '../../src/utils/error-summary';
import { stripAnsi, truncateMiddle } from '../../src/utils/truncate';

describe('extractErrorSummary（v4.1 T1.1 智能摘要）', () => {
  it('tsc → 提取第一个 error TSxxxx 行', () => {
    const err = [
      'src/a.ts(10,5): error TS2322: Type "x" is not assignable to type "y".',
      'src/b.ts(1,1): error TS1005: ...',
    ].join('\n');
    const s = extractErrorSummary(err);
    expect(s.tool).toBe('tsc');
    expect(s.line).toContain('error TS2322');
    expect(s.line).not.toContain('error TS1005');
  });

  it('biome → 提取 × 开头的格式错误行', () => {
    const err = '× [lint/suspicious/noDebugger]: unexpected debugger statement.\nFound 3 errors.\n';
    const s = extractErrorSummary(err);
    expect(s.tool).toBe('biome');
    expect(s.line).toContain('× [lint/suspicious/noDebugger]');
  });

  it('biome → 提取 Found N errors 汇总行', () => {
    const s = extractErrorSummary('Checked 12 files\nFound 2 errors.\n');
    expect(s.tool).toBe('biome');
    expect(s.line).toContain('Found 2 errors');
  });

  it('npm → 提取 npm error 行', () => {
    const err = 'npm error code ELIFECYCLE\nnpm error errno 1\n';
    const s = extractErrorSummary(err);
    expect(s.tool).toBe('npm');
    expect(s.line).toContain('npm error code ELIFECYCLE');
  });

  it('vitest → 提取 FAIL 行', () => {
    const err = 'FAIL tests/a.test.ts > case\nAssertionError: expected 1 to be 2\n';
    const s = extractErrorSummary(err);
    expect(s.tool).toBe('vitest');
    expect(s.line).toContain('FAIL tests/a.test.ts');
  });

  it('未知输出 → 兜底首行（截断 200）', () => {
    const s = extractErrorSummary('line one\nline two');
    expect(s.tool).toBe('unknown');
    expect(s.line).toBe('line one');
  });

  it('空输入 → 空行 + unknown', () => {
    const s = extractErrorSummary('');
    expect(s.tool).toBe('unknown');
    expect(s.line).toBe('');
  });

  it('ANSI 转义码剥离后仍能命中（非 TTY 防御）', () => {
    const err = '\u001b[31merror TS2322: x\u001b[39m';
    const s = extractErrorSummary(err);
    expect(s.tool).toBe('tsc');
    expect(s.line).not.toContain('\u001b[');
  });
});

describe('truncateMiddle（v4.1 T1.1 截断）', () => {
  it('短文本原样返回', () => {
    expect(truncateMiddle('abc', 10)).toBe('abc');
  });

  it('超长 → 保留头尾 + 标注总长，输出总长 ≤ maxChars', () => {
    const text = `${'a'.repeat(100)}HEAD${'b'.repeat(100)}TAIL`;
    const out = truncateMiddle(text, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toContain('已截断，共 208 字符');
    expect(out.startsWith('a')).toBe(true); // 头部保留
    expect(out.endsWith('TAIL')).toBe(true); // 尾部保留
  });

  it('标注计入长度（极端小 max 仍输出标注）', () => {
    const out = truncateMiddle('x'.repeat(100), 5);
    expect(out).toContain('已截断');
    expect(out.length).toBeGreaterThanOrEqual(5);
  });

  it('stripAnsi 剥离 ANSI 颜色码', () => {
    expect(stripAnsi('\u001b[32m+\u001b[39m line')).toBe('+ line');
  });
});
