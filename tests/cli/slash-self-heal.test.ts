/**
 * /self-heal 斜杠命令处理器测试（v3.1 M1 / T1.4）。
 *
 * 覆盖：
 * - parseSelfHealCommand：识别 /self-heal（无参 / 带参），非 self-heal 返回 false；
 * - executeSelfHealCommand：注入 runVerify/runLintFix，验证「verify 通过 → 无需修复」、
 *   「lint 失败 → 自动修复 → 通过」、报告格式化；
 * - formatSelfHealReport：通过 / 修复超限 / 剩余错误 三类报告中文文案。
 */

import { describe, expect, it } from 'vitest';

import {
  executeSelfHealCommand,
  formatSelfHealReport,
  parseSelfHealCommand,
} from '../../src/cli/slash/self-heal';
import type { VerifyReport } from '../../src/loop/self-heal';
import type { ToolContext } from '../../src/tools/registry';

// ── 测试样本 ──────────────────────────────────────────────────

/** 构造 verify 输出（npm 段标记 + 各段文本）。 */
function verifyOutput(segments: Array<[stage: string, body: string]>): {
  stdout: string;
  stderr: string;
} {
  const stdout = segments
    .map(([stage, body]) => `> @concertoai/cli@3.0.0 ${stage}\n${body}`)
    .join('\n');
  return { stdout, stderr: '' };
}

const VERIFY_PASS = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

const LINT_FAIL = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'src/foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━\n  × Unexpected any.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

const TYPE_FAIL = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'."],
  ['test', 'Test Files  1 passed (1)'],
]);

// ── parseSelfHealCommand ──────────────────────────────────────

describe('parseSelfHealCommand', () => {
  it('/self-heal 无参数 → true', () => {
    expect(parseSelfHealCommand('/self-heal')).toBe(true);
  });

  it('/self-heal 带参数 → true（忽略参数）', () => {
    expect(parseSelfHealCommand('/self-heal --verbose')).toBe(true);
  });

  it('非 self-heal 命令 → false', () => {
    expect(parseSelfHealCommand('/plan 任务')).toBe(false);
    expect(parseSelfHealCommand('帮我修复')).toBe(false);
    expect(parseSelfHealCommand('/selfheal')).toBe(false);
  });
});

// ── executeSelfHealCommand ────────────────────────────────────

describe('executeSelfHealCommand', () => {
  const ctx: ToolContext = { cwd: process.cwd() };

  it('verify 通过 → 报告「无需修复」', async () => {
    const result = await executeSelfHealCommand(ctx, {
      runVerify: async () => VERIFY_PASS,
      runLintFix: async () => ({ ok: true }),
    });
    expect(result.result.passed).toBe(true);
    expect(result.message).toContain('无需修复');
  });

  it('lint 失败 → 自动 lint:fix → verify 通过', async () => {
    let lintFixed = false;
    const result = await executeSelfHealCommand(ctx, {
      runVerify: async () => (lintFixed ? VERIFY_PASS : LINT_FAIL),
      runLintFix: async () => {
        lintFixed = true;
        return { ok: true };
      },
    });
    expect(result.result.passed).toBe(true);
    expect(result.result.attempts[0]?.action).toBe('lint-fix');
    expect(result.message).toContain('修复完成');
  });

  it('type 错误且审批拒绝 → 报告转人工（fail-closed）', async () => {
    const result = await executeSelfHealCommand(ctx, {
      requestApproval: () => false,
      runVerify: async () => TYPE_FAIL,
      runLintFix: async () => ({ ok: true }),
    });
    expect(result.result.passed).toBe(false);
    expect(result.message).toContain('人工');
  });
});

// ── formatSelfHealReport ──────────────────────────────────────

describe('formatSelfHealReport', () => {
  function report(passed: boolean, errors: VerifyReport['errors']): VerifyReport {
    return {
      passed,
      errors,
      parseFailed: { build: false, lint: false, type: false, test: false },
      summary: '',
    };
  }

  it('通过且无尝试 → 「verify 全部通过，无需修复」', () => {
    const r: VerifyReport = report(true, []);
    const text = formatSelfHealReport({
      passed: true,
      report: r,
      attempts: [],
      exceeded: false,
    });
    expect(text).toContain('无需修复');
  });

  it('修复后通过 → 显示修复过程与快照提交', () => {
    const r: VerifyReport = report(true, []);
    const text = formatSelfHealReport({
      passed: true,
      report: r,
      attempts: [
        {
          attempt: 1,
          action: 'lint-fix',
          report: r,
          appliedFixes: [],
          feedback: [],
        },
      ],
      exceeded: false,
    });
    expect(text).toContain('修复完成');
    expect(text).toContain('lint 直修');
    expect(text).toContain('快照已提交');
  });

  it('修复超限 → 显示剩余错误明细（转人工）', () => {
    const r: VerifyReport = report(false, [
      {
        stage: 'type',
        file: 'src/foo.ts',
        line: 1,
        code: 'TS2304',
        message: "Cannot find name 'bar'.",
      },
    ]);
    const text = formatSelfHealReport({
      passed: false,
      report: r,
      attempts: [
        {
          attempt: 1,
          action: 'model-fix',
          report: r,
          appliedFixes: [],
          feedback: [],
          rolledBack: true,
          rollbackReason: '目标类型错误 TS2304 未修复',
        },
        {
          attempt: 2,
          action: 'none',
          report: r,
          appliedFixes: [],
          feedback: [{ code: 'TS2304', suggestion: '请手动处理' }],
        },
      ],
      exceeded: true,
    });
    expect(text).toContain('修复超限');
    expect(text).toContain('已回滚');
    expect(text).toContain('剩余错误');
    expect(text).toContain('TS2304');
  });
});
