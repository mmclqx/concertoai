/**
 * AI 自我修复闭环（v3.1 M1）单元测试。
 *
 * 覆盖：
 * - T1.1 分类器：lint FIXABLE / type TS2304（简单错误识别）/ 通过输出；
 * - T1.2 修复执行器：lint 直修（免审批）/ 模型修复审批拒绝 → 跳过；
 * - T1.3 快照与回滚：修复有效 → commit；目标错误未消失 → rollback；
 *   引入新错误 → rollback；回滚失败（外部修改）→ 报错保留快照；未启用快照 → 不回滚；
 * - 工具函数：diffLineStat / parseModelFixOutput。
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  diffLineStat,
  isSimpleTypeError,
  parseModelFixOutput,
  parseVerifyReport,
  type RepairVerifyOptions,
  repairVerifyReport,
} from '../../src/loop/self-heal';
import type { ModelClient } from '../../src/model/client';
import { SnapshotManager } from '../../src/orchestrator/transaction';

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

/** type 简单错误（缺 import）：TS2304 @ src/foo.ts:1。 */
const TYPE_MISSING_IMPORT = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'."],
  ['test', 'Test Files  1 passed (1)'],
]);

/** 全部通过。 */
const VERIFY_PASS = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

/** lint 错误（FIXABLE）：noExplicitAny @ src/foo.ts:1。 */
const LINT_FAIL = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'src/foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━\n  × Unexpected any.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

/** 引入新错误：原 TS2304 消失，新增 TS2322 @ src/foo.ts:5。 */
const AFTER_INTRO = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', "src/foo.ts(5,3): error TS2322: Type 'number' is not assignable to type 'string'."],
  ['test', 'Test Files  1 passed (1)'],
]);

// ── 工具 ──────────────────────────────────────────────────────

/** 返回固定修复 JSON 的 fake ModelClient。 */
function fakeClient(fixJson: string): ModelClient {
  return {
    async *streamChat() {
      yield {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [{ index: 0, delta: { content: fixJson }, finish_reason: null }],
      } as never;
    },
  };
}

/** 临时工作区：src/foo.ts 初始内容 + SnapshotManager。 */
async function makeWorkspace(original: string): Promise<{ cwd: string; fooPath: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'selfheal-'));
  const dir = path.join(cwd, 'src');
  await mkdir(dir, { recursive: true });
  const fooPath = path.join(dir, 'foo.ts');
  await writeFile(fooPath, original, 'utf8');
  return { cwd, fooPath };
}

/** 模型修复方案：把 `a = bar` 改为 `a = foo`（唯一匹配）。 */
const FIX = {
  search: 'export const a = bar;',
  replace: 'export const a = foo;',
  json: JSON.stringify({
    file: 'src/foo.ts',
    search: 'export const a = bar;',
    replace: 'export const a = foo;',
  }),
};

// ── T1.1 分类器 ───────────────────────────────────────────────

describe('self-heal 分类器（T1.1）', () => {
  it('type 段 TS2304 解析为简单类型错误（缺 import）', () => {
    const r = parseVerifyReport(TYPE_MISSING_IMPORT.stdout, TYPE_MISSING_IMPORT.stderr);
    expect(r.passed).toBe(false);
    expect(r.parseFailed).toEqual({ build: false, lint: false, type: false, test: false });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      stage: 'type',
      file: 'src/foo.ts',
      line: 1,
      code: 'TS2304',
    });
    expect(isSimpleTypeError(r.errors[0]!)).toBe(true);
  });

  it('全部通过输出 → passed=true 且无错误', () => {
    const r = parseVerifyReport(VERIFY_PASS.stdout, VERIFY_PASS.stderr);
    expect(r.passed).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('lint 段 FIXABLE 解析为 lint 错误', () => {
    const r = parseVerifyReport(LINT_FAIL.stdout, LINT_FAIL.stderr);
    expect(r.passed).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      stage: 'lint',
      file: 'src/foo.ts',
      line: 1,
      code: 'lint/suspicious/noExplicitAny',
    });
  });
});

// ── 工具函数 ──────────────────────────────────────────────────

describe('self-heal 工具函数', () => {
  it('diffLineStat 统计 SEARCH/REPLACE 行数（空串按 0）', () => {
    expect(diffLineStat('a\nb', 'a\nb\nc')).toEqual({ added: 3, removed: 2 });
    expect(diffLineStat('', 'x')).toEqual({ added: 1, removed: 0 });
    expect(diffLineStat('x', '')).toEqual({ added: 0, removed: 1 });
  });

  it('parseModelFixOutput 容忍 json 围栏且拒绝非法 JSON', () => {
    expect(parseModelFixOutput('```json\n{"file":"a.ts","search":"x","replace":"y"}\n```')).toEqual(
      { file: 'a.ts', search: 'x', replace: 'y' },
    );
    expect(() => parseModelFixOutput('not json')).toThrow(/不是合法 JSON/);
  });
});

// ── T1.2 修复执行器 ───────────────────────────────────────────

describe('self-heal 修复执行器（T1.2）', () => {
  it('lint 错误 → lint:fix 免审批直修', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'selfheal-'));
    let lintFixed = false;
    const options: RepairVerifyOptions = {
      cwd,
      runVerify: async () => (lintFixed ? VERIFY_PASS : LINT_FAIL),
      runLintFix: async () => {
        lintFixed = true;
        return { ok: true };
      },
      requestApproval: () => {
        throw new Error('lint 直修不应触发审批');
      },
      log: () => {},
    };
    const initial = parseVerifyReport(LINT_FAIL.stdout, LINT_FAIL.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(result.passed).toBe(true);
    expect(result.attempts[0]?.action).toBe('lint-fix');
    expect(lintFixed).toBe(true);
  });

  it('模型修复审批拒绝 → 跳过（fail-closed）且文件不变', async () => {
    const { cwd, fooPath } = await makeWorkspace(`import { foo } from './foo';\n${FIX.search}\n`);
    const original = await readFile(fooPath, 'utf8');
    const options: RepairVerifyOptions = {
      cwd,
      client: fakeClient(FIX.json),
      model: 'deepseek-test',
      requestApproval: () => false,
      runVerify: async () => TYPE_MISSING_IMPORT,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    };
    const initial = parseVerifyReport(TYPE_MISSING_IMPORT.stdout, TYPE_MISSING_IMPORT.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(result.passed).toBe(false);
    expect(result.attempts[0]?.action).toBe('none');
    expect(result.attempts[0]?.feedback[0]?.suggestion).toContain('用户拒绝');
    expect(await readFile(fooPath, 'utf8')).toBe(original);
  });
});

// ── T1.3 快照与回滚 ───────────────────────────────────────────

describe('self-heal 快照与回滚（T1.3）', () => {
  it('模型修复有效 → 保留变更并 commit 快照', async () => {
    const { cwd, fooPath } = await makeWorkspace(`import { foo } from './foo';\n${FIX.search}\n`);
    const snapshots = new SnapshotManager(cwd);
    const options: RepairVerifyOptions = {
      cwd,
      client: fakeClient(FIX.json),
      model: 'deepseek-test',
      requestApproval: () => true,
      snapshots,
      runVerify: async () => VERIFY_PASS,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    };
    const initial = parseVerifyReport(TYPE_MISSING_IMPORT.stdout, TYPE_MISSING_IMPORT.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(result.passed).toBe(true);
    // 修复内容保留
    expect(await readFile(fooPath, 'utf8')).toContain(FIX.replace);
    // commit 清理快照
    expect(await snapshots.list()).toEqual([]);
    const attempt = result.attempts[0];
    expect(attempt?.action).toBe('model-fix');
    expect(attempt?.rolledBack).toBeUndefined();
  });

  it('模型修复后目标错误未消失 → rollback 恢复原状', async () => {
    const original = `import { foo } from './foo';\n${FIX.search}\n`;
    const { cwd, fooPath } = await makeWorkspace(original);
    const snapshots = new SnapshotManager(cwd);
    const options: RepairVerifyOptions = {
      cwd,
      client: fakeClient(FIX.json),
      model: 'deepseek-test',
      requestApproval: () => true,
      snapshots,
      // 模型修复后 verify 仍报同一个错误（目标未消失）
      runVerify: async () => TYPE_MISSING_IMPORT,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    };
    const initial = parseVerifyReport(TYPE_MISSING_IMPORT.stdout, TYPE_MISSING_IMPORT.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(result.passed).toBe(false);
    expect(result.exceeded).toBe(true);
    // 文件恢复到修复前（快照回滚）
    expect(await readFile(fooPath, 'utf8')).toBe(original);
    const first = result.attempts[0];
    expect(first?.action).toBe('model-fix');
    expect(first?.rolledBack).toBe(true);
    expect(first?.rollbackReason).toContain('未修复');
    // rollback 成功 → 快照被清理
    expect(await snapshots.list()).toEqual([]);
  });

  it('模型修复引入新错误 → rollback 恢复原状', async () => {
    const original = `import { foo } from './foo';\n${FIX.search}\n`;
    const { cwd, fooPath } = await makeWorkspace(original);
    const snapshots = new SnapshotManager(cwd);
    const options: RepairVerifyOptions = {
      cwd,
      client: fakeClient(FIX.json),
      model: 'deepseek-test',
      requestApproval: () => true,
      snapshots,
      // 修复后原错误消失但出现新错误 TS2322
      runVerify: async () => AFTER_INTRO,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    };
    const initial = parseVerifyReport(TYPE_MISSING_IMPORT.stdout, TYPE_MISSING_IMPORT.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(await readFile(fooPath, 'utf8')).toBe(original);
    const first = result.attempts[0];
    expect(first?.rolledBack).toBe(true);
    expect(first?.rollbackReason).toContain('引入新错误');
    expect(first?.rollbackReason).toContain('TS2322');
  });

  it('回滚失败（外部修改）→ 明确报错并保留快照', async () => {
    const original = `import { foo } from './foo';\n${FIX.search}\n`;
    const { cwd, fooPath } = await makeWorkspace(original);
    const snapshots = new SnapshotManager(cwd);
    let firstVerify = true;
    const options: RepairVerifyOptions = {
      cwd,
      client: fakeClient(FIX.json),
      model: 'deepseek-test',
      requestApproval: () => true,
      snapshots,
      runVerify: async () => {
        // 第一次 verify（模型修复后）：模拟外部修改文件 → 触发回滚失败
        if (firstVerify) {
          firstVerify = false;
          await writeFile(fooPath, 'externally modified', 'utf8');
          return TYPE_MISSING_IMPORT;
        }
        return TYPE_MISSING_IMPORT;
      },
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    };
    const initial = parseVerifyReport(TYPE_MISSING_IMPORT.stdout, TYPE_MISSING_IMPORT.stderr);
    const result = await repairVerifyReport(initial, options);
    // 外部修改未被覆盖
    expect(await readFile(fooPath, 'utf8')).toBe('externally modified');
    const first = result.attempts[0];
    expect(first?.rolledBack).toBeUndefined();
    expect(first?.rollbackReason).toContain('回滚失败');
    expect(first?.rollbackReason).toContain('快照保留');
    // 至少保留一个快照目录（第一轮回滚失败未清理；第二轮成功清理自己的）
    const leftover = await snapshots.list();
    expect(leftover.length).toBeGreaterThan(0);
  });

  it('未启用快照 → 修复无效时不回滚（保留变更 + 提示）', async () => {
    const { cwd, fooPath } = await makeWorkspace(`import { foo } from './foo';\n${FIX.search}\n`);
    const options: RepairVerifyOptions = {
      cwd,
      client: fakeClient(FIX.json),
      model: 'deepseek-test',
      requestApproval: () => true,
      // 不传 snapshots
      runVerify: async () => TYPE_MISSING_IMPORT,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    };
    const initial = parseVerifyReport(TYPE_MISSING_IMPORT.stdout, TYPE_MISSING_IMPORT.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(result.passed).toBe(false);
    // 无快照 → 文件保留修复内容
    expect(await readFile(fooPath, 'utf8')).toContain(FIX.replace);
    const first = result.attempts[0];
    expect(first?.rolledBack).toBeUndefined();
    expect(first?.rollbackReason).toContain('未启用快照');
  });
});
