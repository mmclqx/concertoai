/**
 * Reviewer autoFix 测试（v4.0 M1 T1.1-T1.5）。
 *
 * 覆盖：A/B 分批 / 补丁生成（mock 模型）/ 批量审批（fail-closed）/
 * 快照写盘回滚 / 修复结果报告区块 / /review --fix 解析。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubagentSpawner } from '../../src/agent/spawner';
import { parseReviewCommand } from '../../src/cli/slash/review';
import type { ModelClient } from '../../src/model/client';
import { SnapshotManager } from '../../src/orchestrator/transaction';
import {
  categorizeIssue,
  generateReviewFixPlan,
  parseReviewFixOutput,
  runAutoFix,
} from '../../src/reviewer/autofix';
import { ReviewerEngine } from '../../src/reviewer/engine';
import type { ReviewDimension, ReviewIssue, ReviewReport } from '../../src/reviewer/types';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-autofix-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── A/B 分批（T1.2）────────────────────────────────────────

describe('categorizeIssue（A/B 分批）', () => {
  it('suggestion + 有文件 → A 类（可尝试自动修）', () => {
    const issue = makeIssue('style', 'suggestion', 'src/a.ts', '命名建议');
    expect(categorizeIssue(issue)).toBe('A');
  });

  it('critical → B 类（需人工判断）', () => {
    expect(categorizeIssue(makeIssue('security', 'critical', 'src/a.ts', '注入风险'))).toBe('B');
  });

  it('medium → B 类（需人工判断）', () => {
    expect(categorizeIssue(makeIssue('types', 'medium', 'src/a.ts', '类型隐患'))).toBe('B');
  });

  it('suggestion 但无文件 → B 类（无法定位）', () => {
    const issue = makeIssue('docs', 'suggestion', '', '文档建议');
    expect(categorizeIssue(issue)).toBe('B');
  });
});

// ── 补丁生成解析（模型输出）────────────────────────────────

describe('parseReviewFixOutput', () => {
  it('合法 JSON → 解析 search/replace', () => {
    const out = parseReviewFixOutput('{"search":"const a = 1","replace":"const a = 2"}');
    expect(out).toEqual({ search: 'const a = 1', replace: 'const a = 2' });
  });

  it('容忍 ```json 围栏与前后空白', () => {
    const out = parseReviewFixOutput('```json\n{"search":"a","replace":"b"}\n```');
    expect(out).toEqual({ search: 'a', replace: 'b' });
  });

  it('非合法 JSON → 抛错', () => {
    expect(() => parseReviewFixOutput('not json')).toThrow('不是合法 JSON');
  });

  it('结构缺字段 → 抛错', () => {
    expect(() => parseReviewFixOutput('{"search":"a"}')).toThrow('结构不符合协议');
  });

  it('空 search+replace（模型判定不可修）→ 抛错', () => {
    expect(() => parseReviewFixOutput('{"search":"","replace":""}')).toThrow('无法安全修复');
  });
});

// ── 补丁生成（模型调用 + planEdit 校验）────────────────────

describe('generateReviewFixPlan', () => {
  it('模型输出合法补丁 + search 唯一 → 返回计划', async () => {
    const client = mockClient('{"search":"const old = 1","replace":"const old = 2"}');
    const plan = await generateReviewFixPlan(
      makeIssue('style', 'suggestion', 'src/a.ts', '常量命名'),
      'const old = 1;',
      client,
      'test-model',
    );
    expect(plan).toBeDefined();
    expect(plan?.newContent).toBe('const old = 2;');
    expect(plan?.diff).toContain('const old');
  });

  it('search 不唯一 → 返回 undefined（降级 manual）', async () => {
    // 文件里 "x" 出现两次，模型 search 用 "x" → planEdit 抛错
    const client = mockClient('{"search":"x","replace":"y"}');
    const plan = await generateReviewFixPlan(
      makeIssue('style', 'suggestion', 'src/a.ts', '命名'),
      'x = 1; x = 2;',
      client,
      'test-model',
    );
    expect(plan).toBeUndefined();
  });

  it('模型输出非 JSON → 返回 undefined', async () => {
    const client = mockClient('not json');
    const plan = await generateReviewFixPlan(
      makeIssue('style', 'suggestion', 'src/a.ts', '命名'),
      'abc',
      client,
      'test-model',
    );
    expect(plan).toBeUndefined();
  });
});

// ── 修复执行引擎（T1.3 + T1.5）─────────────────────────────

describe('runAutoFix（执行引擎）', () => {
  it('无模型能力 → A 类全部 manual，不写盘', async () => {
    writeFileSync(path.join(tmp, 'a.ts'), 'const old = 1;', 'utf8');
    const report = makeReport([
      makeIssue('style', 'suggestion', 'a.ts', '命名'),
      makeIssue('security', 'critical', 'a.ts', '注入'),
    ]);
    const result = await runAutoFix(report, {
      cwd: tmp,
      requestApproval: async () => true,
    });
    expect(result.fixed).toBe(0);
    expect(result.manual).toBe(2);
    expect(readFileSync(path.join(tmp, 'a.ts'), 'utf8')).toBe('const old = 1;');
  });

  it('批量审批拒绝（fail-closed）→ 全部 manual，不写盘', async () => {
    writeFileSync(path.join(tmp, 'a.ts'), 'const old = 1;', 'utf8');
    const report = makeReport([makeIssue('style', 'suggestion', 'a.ts', '命名')]);
    let approvalCalled = false;
    const result = await runAutoFix(report, {
      cwd: tmp,
      client: mockClient('{"search":"const old = 1","replace":"const old = 2"}'),
      model: 'test-model',
      requestApproval: async () => {
        approvalCalled = true;
        return false;
      },
    });
    expect(approvalCalled).toBe(true);
    expect(result.fixed).toBe(0);
    expect(result.manual).toBe(1);
    expect(result.items[0]?.reason).toContain('拒绝');
    expect(readFileSync(path.join(tmp, 'a.ts'), 'utf8')).toBe('const old = 1;');
  });

  it('审批通过 + verify 通过 → fixed，文件已写，快照 commit', async () => {
    const file = path.join(tmp, 'a.ts');
    writeFileSync(file, 'const old = 1;', 'utf8');
    const report = makeReport([makeIssue('style', 'suggestion', 'a.ts', '命名')]);
    const snapshots = new SnapshotManager(tmp);
    const result = await runAutoFix(report, {
      cwd: tmp,
      client: mockClient('{"search":"const old = 1","replace":"const old = 2"}'),
      model: 'test-model',
      requestApproval: async () => true,
      snapshots,
      runVerify: async () => ({ passed: true }),
    });
    expect(result.fixed).toBe(1);
    expect(result.rolledBack).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('const old = 2;');
    // 快照已 commit（目录清理）
    expect(await snapshots.list()).toEqual([]);
  });

  it('verify 失败 → 自动回滚，文件恢复原状', async () => {
    const file = path.join(tmp, 'a.ts');
    writeFileSync(file, 'const old = 1;', 'utf8');
    const report = makeReport([makeIssue('style', 'suggestion', 'a.ts', '命名')]);
    const snapshots = new SnapshotManager(tmp);
    const result = await runAutoFix(report, {
      cwd: tmp,
      client: mockClient('{"search":"const old = 1","replace":"const old = 2"}'),
      model: 'test-model',
      requestApproval: async () => true,
      snapshots,
      runVerify: async () => ({ passed: false }),
    });
    expect(result.fixed).toBe(0);
    expect(result.rolledBack).toBe(1);
    expect(result.items[0]?.status).toBe('rolledback');
    // 回滚后文件恢复
    expect(readFileSync(file, 'utf8')).toBe('const old = 1;');
  });

  it('文件不存在 → manual', async () => {
    const report = makeReport([makeIssue('style', 'suggestion', 'missing.ts', '命名')]);
    const result = await runAutoFix(report, {
      cwd: tmp,
      client: mockClient('{"search":"a","replace":"b"}'),
      model: 'test-model',
      requestApproval: async () => true,
    });
    expect(result.manual).toBe(1);
    expect(result.items[0]?.reason).toContain('不存在');
  });

  it('B 类 + A 类混合 → 只处理 A 类', async () => {
    writeFileSync(path.join(tmp, 'a.ts'), 'const old = 1;', 'utf8');
    const report = makeReport([
      makeIssue('style', 'suggestion', 'a.ts', '命名'),
      makeIssue('security', 'critical', 'a.ts', '注入'),
    ]);
    const result = await runAutoFix(report, {
      cwd: tmp,
      client: mockClient('{"search":"const old = 1","replace":"const old = 2"}'),
      model: 'test-model',
      requestApproval: async () => true,
      runVerify: async () => ({ passed: true }),
    });
    expect(result.fixed).toBe(1);
    expect(result.manual).toBe(1); // critical 未自动修
  });

  it('空报告 → 不调用审批、不写盘（T1.1 无问题短路）', async () => {
    const report = makeReport([]);
    let approvalCalled = false;
    const result = await runAutoFix(report, {
      cwd: tmp,
      requestApproval: async () => {
        approvalCalled = true;
        return true;
      },
    });
    expect(approvalCalled).toBe(false);
    expect(result.fixed).toBe(0);
    expect(result.manual).toBe(0);
    expect(result.rolledBack).toBe(0);
    expect(result.items).toEqual([]);
  });
});

// ── engine.autoFix 无问题短路（T1.1）─────────────────────────

describe('ReviewerEngine.autoFix 无问题短路', () => {
  it('空报告 → 直接返回，不附加 fixResult 区块', async () => {
    // autoFix 不使用 spawner，仅需构造（cwd 指向临时目录）
    const engine = new ReviewerEngine({} as SubagentSpawner, tmp);
    const report = makeReport([]);
    let approvalCalled = false;
    const result = await engine.autoFix(report, {
      cwd: tmp,
      requestApproval: async () => {
        approvalCalled = true;
        return true;
      },
    });
    expect(approvalCalled).toBe(false);
    expect(result.fixed).toBe(0);
    expect(result.report.fixResult).toBeUndefined();
    expect(ReviewerEngine.formatReport(result.report)).not.toContain('修复结果');
  });
});

// ── 修复结果报告区块（T1.4）───────────────────────────────

describe('ReviewerEngine.formatReport 修复结果区块', () => {
  it('fixResult 存在 → 渲染统计行与逐条结果', () => {
    const report = makeReport([makeIssue('style', 'suggestion', 'src/a.ts', '命名')]);
    report.fixResult = {
      fixed: 1,
      manual: 0,
      rolledBack: 0,
      items: [
        {
          issue: report.issues[0] as ReviewIssue,
          category: 'A',
          status: 'fixed',
        },
      ],
    };
    const text = ReviewerEngine.formatReport(report);
    expect(text).toContain('修复结果');
    expect(text).toContain('已修复 1 个');
  });

  it('无 fixResult → 不渲染修复区块（回归）', () => {
    const report = makeReport([]);
    const text = ReviewerEngine.formatReport(report);
    expect(text).not.toContain('修复结果');
  });

  it('fixed 项带 diff → 渲染 diff 摘要（T1.4 每条带 diff）', () => {
    const report = makeReport([makeIssue('style', 'suggestion', 'src/a.ts', '命名')]);
    report.fixResult = {
      fixed: 1,
      manual: 0,
      rolledBack: 0,
      items: [
        {
          issue: report.issues[0] as ReviewIssue,
          category: 'A',
          status: 'fixed',
          diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const old = 1;\n+const old = 2;',
        },
      ],
    };
    const text = ReviewerEngine.formatReport(report);
    expect(text).toContain('已修复 1 个');
    expect(text).toContain('const old = 1');
    expect(text).toContain('const old = 2');
  });

  it('rolledback 项带 diff 与原因 → 渲染撤销标记 + diff + 原因（T1.4）', () => {
    const report = makeReport([makeIssue('style', 'suggestion', 'src/a.ts', '命名')]);
    report.fixResult = {
      fixed: 0,
      manual: 0,
      rolledBack: 1,
      items: [
        {
          issue: report.issues[0] as ReviewIssue,
          category: 'A',
          status: 'rolledback',
          diff: '-const old = 1;\n+const old = 2;',
          reason: 'verify failed after fix; auto-reverted',
        },
      ],
    };
    const text = ReviewerEngine.formatReport(report);
    expect(text).toContain('自动回滚 1 个');
    expect(text).toContain('verify failed');
    expect(text).toContain('-const old = 1;');
  });
});

// ── /review --fix 解析（T1.1）──────────────────────────────

describe('parseReviewCommand --fix', () => {
  it('/review --fix → auto + fix', () => {
    expect(parseReviewCommand('/review --fix')).toEqual({ type: 'auto', fix: true });
  });

  it('/review --fix --severity strict → auto + severity + fix 组合', () => {
    expect(parseReviewCommand('/review --fix --severity strict')).toEqual({
      type: 'auto',
      severity: 'strict',
      fix: true,
    });
  });

  it('/review src/tools --fix → files + fix', () => {
    expect(parseReviewCommand('/review src/tools --fix')).toEqual({
      type: 'files',
      paths: ['src/tools'],
      fix: true,
    });
  });

  it('/review --pr --fix → pr + fix', () => {
    expect(parseReviewCommand('/review --pr --fix')).toEqual({ type: 'pr', fix: true });
  });

  it('/review（无 --fix）→ 不带 fix 标志（回归）', () => {
    expect(parseReviewCommand('/review')).toEqual({ type: 'auto' });
  });
});

// ── 辅助 ────────────────────────────────────────────────────

function mockClient(json: string): ModelClient {
  return {
    async *streamChat() {
      yield {
        choices: [{ delta: { content: json } }],
      } as never;
    },
  };
}

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
