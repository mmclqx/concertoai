/**
 * Reviewer Agent 集成测试（v2.1 M6）。
 *
 * 覆盖：/review 命令解析、引擎结果聚合、报告格式化。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeReviewCommand, parseReviewCommand } from '../../src/cli/slash/review';
import { formatContextArtifacts, ReviewerEngine } from '../../src/reviewer/engine';
import type { ReviewDimension, ReviewIssue } from '../../src/reviewer/types';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-review-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── 命令解析 ──────────────────────────────────────────────

describe('parseReviewCommand', () => {
  it('/review → auto 模式', () => {
    expect(parseReviewCommand('/review')).toEqual({ type: 'auto' });
  });

  it('/review --pr → PR 模式', () => {
    expect(parseReviewCommand('/review --pr')).toEqual({ type: 'pr' });
  });

  it('/review src/tools → files 模式', () => {
    expect(parseReviewCommand('/review src/tools')).toEqual({
      type: 'files',
      paths: ['src/tools'],
    });
  });

  it('/review src/a.ts src/b.ts → 多文件', () => {
    const cmd = parseReviewCommand('/review src/a.ts src/b.ts');
    expect(cmd).toEqual({ type: 'files', paths: ['src/a.ts', 'src/b.ts'] });
  });

  it('非 /review 命令 → null', () => {
    expect(parseReviewCommand('hello')).toBeNull();
    expect(parseReviewCommand('/plan task')).toBeNull();
  });
});

// ── 命令执行 ──────────────────────────────────────────────

describe('executeReviewCommand', () => {
  it('auto 模式 → 提示审查范围', () => {
    const result = executeReviewCommand({ type: 'auto' });
    expect(result.handled).toBe(false);
    expect(result.message?.content).toContain('🔍');
    expect(result.message?.content).toContain('最近修改');
  });

  it('PR 模式 → 提示 PR diff', () => {
    const result = executeReviewCommand({ type: 'pr' });
    expect(result.message?.content).toContain('PR diff');
  });

  it('files 模式 → 显示文件列表', () => {
    const result = executeReviewCommand({ type: 'files', paths: ['src/a.ts'] });
    expect(result.message?.content).toContain('src/a.ts');
  });
});

// ── 报告格式化 ────────────────────────────────────────────

describe('ReviewerEngine.formatReport', () => {
  it('空报告 → 显示无问题', () => {
    const report = makeReport([]);
    const text = ReviewerEngine.formatReport(report);
    expect(text).toContain('审查报告');
    expect(text).toContain('未发现明显问题');
  });

  it('含 critical 问题 → 按严重程度分组', () => {
    const issues: ReviewIssue[] = [
      makeIssue('security', 'critical', 'src/a.ts', 'SQL 注入风险'),
      makeIssue('types', 'critical', 'src/b.ts', 'any 滥用'),
      makeIssue('style', 'suggestion', 'src/c.ts', '命名建议'),
    ];
    const report = makeReport(issues);
    const text = ReviewerEngine.formatReport(report);

    expect(text).toContain('🔴 严重问题');
    expect(text).toContain('🟢 改进建议');
    expect(text).toContain('SQL 注入风险');
    expect(text).toContain('any 滥用');
  });

  it('汇总表包含各维度统计', () => {
    const issues: ReviewIssue[] = [makeIssue('types', 'critical', 'src/x.ts', '类型问题')];
    const report = makeReport(issues);
    const text = ReviewerEngine.formatReport(report);

    expect(text).toContain('📊 汇总');
    expect(text).toContain('types');
    expect(text).toContain('1'); // critical count
  });
});

// ── 上下文工件格式化（v3.0 I2 修复）───────────────────────

describe('formatContextArtifacts（Reviewer 可见上下文代码工件）', () => {
  it('无工件（undefined / 空数组）→ 返回空字符串', () => {
    expect(formatContextArtifacts(undefined)).toBe('');
    expect(formatContextArtifacts([])).toBe('');
  });

  it('含 code 工件 → 生成带路径的内联代码块', () => {
    const text = formatContextArtifacts([
      { type: 'code', path: 'src/a.ts', content: 'export const a = 1;' },
    ]);
    expect(text).toContain('上下文代码工件');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('export const a = 1;');
  });

  it('无路径工件 → 标记为「无路径工件」', () => {
    const text = formatContextArtifacts([{ type: 'file', content: 'plain' }]);
    expect(text).toContain('无路径工件');
    expect(text).toContain('plain');
  });

  it('多个工件 → 逐个分隔', () => {
    const text = formatContextArtifacts([
      { type: 'code', path: 'src/a.ts', content: 'aaa' },
      { type: 'code', path: 'src/b.ts', content: 'bbb' },
    ]);
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
  });
});

// ── 辅助函数 ──────────────────────────────────────────────

function makeIssue(
  dimension: ReviewDimension,
  severity: 'critical' | 'medium' | 'suggestion',
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

function makeReport(issues: ReviewIssue[]) {
  const summary = {} as Record<
    ReviewDimension,
    { critical: number; medium: number; suggestion: number }
  >;
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
    scope: 'src/tools/read.ts',
    timestamp: new Date().toISOString(),
    testPassed: true,
    issues,
    summary,
    durationMs: 1234,
  };
}
