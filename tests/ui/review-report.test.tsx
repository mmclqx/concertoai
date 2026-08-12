/**
 * ReviewReportView 渲染测试（v4.0 M1 T1.4：修复结果区块 ink-testing-library UI 用例）。
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { ReviewDimension, ReviewIssue, ReviewReport } from '../../src/reviewer/types';
import { ReviewReportView } from '../../src/ui/ReviewReport';

describe('ReviewReportView 修复结果区块（v4.0 M1 T1.4）', () => {
  it('fixResult 存在 → 渲染三分类统计与逐条结果', () => {
    const report = makeReport([
      makeIssue('style', 'suggestion', 'src/a.ts', '常量命名'),
      makeIssue('security', 'critical', 'src/b.ts', '注入风险'),
    ]);
    report.fixResult = {
      fixed: 1,
      manual: 1,
      rolledBack: 0,
      items: [
        {
          issue: report.issues[0] as ReviewIssue,
          category: 'A',
          status: 'fixed',
        },
        {
          issue: report.issues[1] as ReviewIssue,
          category: 'B',
          status: 'manual',
          reason: '复杂问题，需人工判断',
        },
      ],
    };
    const { lastFrame, unmount } = render(<ReviewReportView report={report} />);
    const frame = lastFrame();
    expect(frame).toContain('修复结果');
    expect(frame).toContain('已修复 1 个');
    expect(frame).toContain('需人工处理 1 个');
    expect(frame).toContain('src/a.ts');
    expect(frame).toContain('src/b.ts');
    expect(frame).toContain('复杂问题，需人工判断');
    unmount();
  });

  it('无 fixResult → 不渲染修复结果区块（回归）', () => {
    const { lastFrame, unmount } = render(<ReviewReportView report={makeReport([])} />);
    expect(lastFrame()).not.toContain('修复结果');
    unmount();
  });
});

// ── 辅助 ────────────────────────────────────────────────────

function makeIssue(
  dimension: ReviewDimension,
  severity: ReviewIssue['severity'],
  file: string,
  title: string,
): ReviewIssue {
  return {
    dimension,
    severity,
    file,
    line: 42,
    title,
    description: `${title} 的详细描述`,
    suggestion: severity === 'suggestion' ? `修复 ${title}` : undefined,
  };
}

function makeReport(issues: ReviewIssue[]): ReviewReport {
  const summary = {} as ReviewReport['summary'];
  const dims: ReviewDimension[] = [
    'architecture',
    'style',
    'types',
    'errors',
    'tests',
    'security',
    'performance',
    'maintainability',
    'docs',
  ];
  for (const dim of dims) {
    summary[dim] = { critical: 0, medium: 0, suggestion: 0 };
  }
  for (const issue of issues) {
    summary[issue.dimension][issue.severity] += 1;
  }
  return {
    scope: 'test',
    timestamp: new Date().toISOString(),
    testPassed: true,
    issues,
    summary,
    durationMs: 0,
  };
}
