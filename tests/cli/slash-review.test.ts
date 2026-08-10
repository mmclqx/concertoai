/**
 * /review --severity 测试（v3.1 M5 / T5.4）。
 *
 * 覆盖验收标准：
 * - /review --severity strict：🟡 medium 问题也触发 reject（与 v3.0 默认不同）；
 * - /review --severity lenient：仅 🔴 critical 触发 reject（🟡 不阻断）；
 * - /review 无参数：保持 v3.0 默认（critical 必 reject / medium 可 reject）；
 * - 非法 severity 值 → 报错并列出合法值；
 * - determineReviewAction 三档阈值差异（normal 下 medium 结合 testPassed）。
 */

import { describe, expect, it } from 'vitest';

import { executeReviewCommand, parseReviewCommand } from '../../src/cli/slash/review';
import type { ReviewIssue, ReviewReport } from '../../src/reviewer';
import { buildReviewResult, determineReviewAction } from '../../src/reviewer';

/** 构造单个审查问题。 */
function makeIssue(severity: 'critical' | 'medium' | 'suggestion'): ReviewIssue {
  return {
    dimension: 'types',
    severity,
    file: 'src/a.ts',
    line: 1,
    title: `${severity} 问题`,
    description: '描述',
  };
}

/** 构造审查报告（testPassed 可注入）。 */
function makeReport(issues: ReviewIssue[], testPassed: boolean | null = null): ReviewReport {
  return {
    scope: 'src/a.ts',
    timestamp: '2026-01-01T00:00:00.000Z',
    testPassed,
    issues,
    summary: {} as ReviewReport['summary'],
    durationMs: 1,
  };
}

describe('parseReviewCommand --severity', () => {
  it('/review --severity strict → auto + severity', () => {
    expect(parseReviewCommand('/review --severity strict')).toEqual({
      type: 'auto',
      severity: 'strict',
    });
  });

  it('/review --severity lenient --pr → pr + severity', () => {
    expect(parseReviewCommand('/review --severity lenient --pr')).toEqual({
      type: 'pr',
      severity: 'lenient',
    });
  });

  it('/review --severity normal src/a.ts → files + severity', () => {
    expect(parseReviewCommand('/review --severity normal src/a.ts')).toEqual({
      type: 'files',
      paths: ['src/a.ts'],
      severity: 'normal',
    });
  });

  it('/review 无 severity → 保持 v3.0 形态', () => {
    expect(parseReviewCommand('/review')).toEqual({ type: 'auto' });
    expect(parseReviewCommand('/review src/a.ts')).toEqual({
      type: 'files',
      paths: ['src/a.ts'],
    });
  });

  it('非法 severity → unknown 报错并列出合法值', () => {
    const result = parseReviewCommand('/review --severity bogus');
    expect(result).not.toBeNull();
    if (result !== null && result.type === 'unknown') {
      expect(result.message).toContain('非法 severity');
      expect(result.message).toContain('strict');
      expect(result.message).toContain('normal');
      expect(result.message).toContain('lenient');
    } else {
      expect.unreachable('应返回 unknown');
    }
  });
});

describe('executeReviewCommand --severity', () => {
  it('非法 severity → handled 且回显错误（不启动审查）', () => {
    const result = executeReviewCommand({
      type: 'unknown',
      message: '非法 severity 值: bogus。合法值: strict / normal / lenient',
    });
    expect(result.handled).toBe(true);
    expect(result.message?.content).toContain('非法 severity');
  });

  it('合法 severity → handled=false + 启动消息含审查阈值', () => {
    const result = executeReviewCommand({ type: 'auto', severity: 'strict' });
    expect(result.handled).toBe(false);
    expect(result.message?.content).toContain('strict');
  });
});

describe('determineReviewAction 三档阈值（T5.4）', () => {
  it('strict：🟡 medium 也触发 reject（与 normal 不同）', () => {
    expect(determineReviewAction([makeIssue('medium')], { severity: 'strict' })).toBe('reject');
    expect(determineReviewAction([makeIssue('medium')], { severity: 'strict' })).toBe('reject');
  });

  it('normal：critical 必拒；medium 仅 QA 失败（testPassed=false）时拒', () => {
    // critical → 必 reject
    expect(determineReviewAction([makeIssue('critical')], { severity: 'normal' })).toBe('reject');
    // medium + 测试通过/未运行 → approve（medium 可拒而非必拒）
    expect(
      determineReviewAction([makeIssue('medium')], { severity: 'normal', testPassed: true }),
    ).toBe('approve');
    expect(determineReviewAction([makeIssue('medium')])).toBe('approve');
    // medium + QA 失败 → reject
    expect(
      determineReviewAction([makeIssue('medium')], { severity: 'normal', testPassed: false }),
    ).toBe('reject');
  });

  it('lenient：仅 critical 触发 reject（🟡 不阻断）', () => {
    expect(determineReviewAction([makeIssue('critical')], { severity: 'lenient' })).toBe('reject');
    expect(determineReviewAction([makeIssue('medium')], { severity: 'lenient' })).toBe('approve');
    expect(
      determineReviewAction([makeIssue('medium')], { severity: 'lenient', testPassed: false }),
    ).toBe('approve');
  });

  it('buildReviewResult 透传 severity（normal 下 medium + testPassed=false → reject）', () => {
    const report = makeReport([makeIssue('medium')], false);
    expect(buildReviewResult(report, 'normal').action).toBe('reject');
    const report2 = makeReport([makeIssue('medium')], true);
    expect(buildReviewResult(report2, 'normal').action).toBe('approve');
  });

  it('无参数（v3.0 默认）：critical 必拒 / medium 可拒（testPassed 缺省 → 不拒）', () => {
    expect(determineReviewAction([makeIssue('critical')])).toBe('reject');
    expect(determineReviewAction([makeIssue('suggestion')])).toBe('approve');
    expect(determineReviewAction([])).toBe('approve');
  });
});
