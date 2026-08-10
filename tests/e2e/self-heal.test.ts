/**
 * self-heal 全链路 E2E（v3.1 M6 / T6.1 E2E-2/3）。
 *
 * 端到端串联（runSelfHeal 入口 + 真实磁盘 + SnapshotManager 回滚）：
 * - E2E-2：注入 lint 错误 → verify 失败 → 自动 lint:fix → verify 通过（闭环收敛）；
 * - E2E-3：注入 type 简单错误 → 模型生成修复（审批通过）→ 修复后 verify 仍失败
 *   → 回滚 → 文件恢复到修复前状态（快照原子性）。
 *
 * 依赖：M1（self-heal.ts / SnapshotManager）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSelfHeal } from '../../src/loop/self-heal';
import type { ModelClient } from '../../src/model/client';

/** 构造 verify 输出（npm 段标记 + 各段文本）。 */
function verifyOutput(segments: Array<[stage: string, body: string]>): {
  stdout: string;
  stderr: string;
} {
  return {
    stdout: segments.map(([stage, body]) => `> @concertoai/cli@3.0.0 ${stage}\n${body}`).join('\n'),
    stderr: '',
  };
}

const LINT_FAIL = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'src/foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━\n  × Unexpected any.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

const VERIFY_PASS = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

const TYPE_MISSING_IMPORT = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'."],
  ['test', 'Test Files  1 passed (1)'],
]);

/** 固定修复 JSON 的 fake ModelClient（模型修复输出）。 */
const FIX_JSON = JSON.stringify({
  file: 'src/foo.ts',
  search: 'export const a = bar;',
  replace: 'export const a = foo;',
});
function fakeClient(): ModelClient {
  return {
    async *streamChat() {
      yield {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [{ index: 0, delta: { content: FIX_JSON }, finish_reason: null }],
      } as never;
    },
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'e2e-self-heal-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('E2E：self-heal lint 修复闭环（E2E-2）', () => {
  it('注入 lint 错误 → verify 失败 → 自动 lint:fix → verify 通过', async () => {
    let lintFixed = false;
    const result = await runSelfHeal({
      cwd: tmp,
      runVerify: async () => (lintFixed ? VERIFY_PASS : LINT_FAIL),
      runLintFix: async () => {
        lintFixed = true;
        return { ok: true };
      },
      log: () => {},
    });
    expect(result.passed).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.action).toBe('lint-fix');
    expect(lintFixed).toBe(true);
    expect(result.report.summary).toContain('全部通过');
  });
});

describe('E2E：self-heal type 修复失败 → 快照回滚（E2E-3）', () => {
  it('模型修复后 verify 仍失败 → 文件回滚到修复前状态（快照原子性）', async () => {
    // 真实工作区：src/foo.ts 含未定义引用 bar（缺 import）
    const srcDir = path.join(tmp, 'src');
    mkdirSync(srcDir, { recursive: true });
    const fooPath = path.join(srcDir, 'foo.ts');
    const original = `export const a = bar;\n`;
    writeFileSync(fooPath, original, 'utf8');

    const result = await runSelfHeal({
      cwd: tmp,
      client: fakeClient(),
      model: 'deepseek-test',
      requestApproval: async () => true, // 审批通过
      // 修复后 verify 仍报同一错误（模型修复无效）→ 触发回滚
      runVerify: async () => TYPE_MISSING_IMPORT,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    });

    expect(result.passed).toBe(false);
    expect(result.exceeded).toBe(true);
    // 模型修复被尝试（model-fix 动作），随后回滚
    expect(result.attempts.some((a) => a.action === 'model-fix')).toBe(true);
    expect(result.attempts.every((a) => a.rolledBack === true || a.action !== 'model-fix')).toBe(
      true,
    );
    // 文件恢复到修复前状态（快照回滚原子性）
    expect(readFileSync(fooPath, 'utf8')).toBe(original);
    // 回滚成功 → 快照清理（runSelfHeal 内部 SnapshotManager 按 self-heal- 前缀）
    const snapRoot = path.join(tmp, '.concertoai', 'snapshots');
    const { existsSync, readdirSync } = await import('node:fs');
    const left = existsSync(snapRoot)
      ? readdirSync(snapRoot).filter((f) => f.startsWith('self-heal-'))
      : [];
    expect(left).toEqual([]);
  });
});
