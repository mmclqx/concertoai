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

import { describe, expect, it, vi } from 'vitest';
import {
  diffLineStat,
  isSimpleTypeError,
  parseModelFixOutput,
  parseVerifyReport,
  type RepairVerifyOptions,
  repairVerifyReport,
  runSelfHeal,
} from '../../src/loop/self-heal';
import type { ModelClient } from '../../src/model/client';
import { SnapshotManager } from '../../src/orchestrator/transaction';
import {
  BIOME_ASSIST_ERROR_POSIX,
  BIOME_FORMAT_ERROR_WIN,
  BIOME_LINT_ERROR_POSIX,
  BIOME_LINT_ERROR_WIN,
  TSC_ERROR_PRETTY_POSIX,
  TSC_ERROR_WIN,
} from '../fixtures/platform-samples';

// ── 测试样本 ──────────────────────────────────────────────────

/** 构造 verify 输出（npm 段标记 + 各段文本）。 */
function verifyOutput(segments: Array<[stage: string, body: string]>): {
  stdout: string;
  stderr: string;
} {
  const stdout = segments
    .map(([stage, body]) => `> @concertoai/cli@4.1.0 ${stage}\n${body}`)
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

/**
 * Windows 下 Biome format 错误（v3.1.1 回归样本）：`src/version.ts:9:1 format`（多余分号）。
 * 路径用反斜杠分隔，错误码是 `format`（无 lint/ 前缀）——旧正则无法匹配。
 */
const LINT_FORMAT_WIN = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'src\\version.ts:9:1 format  FIXABLE  ━━━\n  × Unnecessary semicolon.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

/** assist 类别错误（organizeImports）：`assist/source/organizeImports`（非 lint/ 前缀）。 */
const LINT_ASSIST = verifyOutput([
  ['build', 'Build success.'],
  [
    'lint',
    'src\\cli\\slash\\agent.ts:19:1 assist/source/organizeImports  FIXABLE  ━━━\n  × Sort the imported names.',
  ],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

/** 整文件 format 错误（无行列号）：`tests\cli\foo.test.ts format ━━━`。 */
const LINT_FORMAT_NO_LOC = verifyOutput([
  ['build', 'Build success.'],
  [
    'lint',
    'tests\\cli\\slash-agent.test.ts format ━━━━━━━━━━━━━━━━━━━\n  × Formatter would have printed the following content:',
  ],
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

/** build 失败（tsup）：无 file/line，仅 message。 */
const BUILD_FAIL = verifyOutput([
  ['build', 'CLI Build Error: RollupError: Could not resolve "./missing" from src/index.ts'],
  ['lint', 'All checks passed.'],
  ['typecheck', ''],
  ['test', 'Test Files  1 passed (1)'],
]);

/** test 失败（vitest FAIL 段）：FAIL 文件行 + ✗ 用例名 + AssertionError。 */
const TEST_FAIL = verifyOutput([
  ['build', 'Build success.'],
  ['lint', 'All checks passed.'],
  ['typecheck', ''],
  [
    'test',
    [
      'Test Files  1 failed (1)',
      '  FAIL src/foo.test.ts',
      '  ✗ 加法应该正确',
      'AssertionError: expected 1 to be 2',
    ].join('\n'),
  ],
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
    const firstError = r.errors[0];
    expect(firstError).toBeDefined();
    if (firstError !== undefined) {
      expect(isSimpleTypeError(firstError)).toBe(true);
    }
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

  it('Windows 路径 format 错误（src\\version.ts:9:1 format）→ 识别为 lint（v3.1.1 回归）', () => {
    const r = parseVerifyReport(LINT_FORMAT_WIN.stdout, LINT_FORMAT_WIN.stderr);
    expect(r.passed).toBe(false);
    expect(r.parseFailed.lint).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      stage: 'lint',
      file: 'src\\version.ts',
      line: 9,
      code: 'format',
    });
    expect(r.errors[0]?.message).toContain('Unnecessary semicolon');
  });

  it('assist 类别错误（assist/source/organizeImports）→ 识别为 lint', () => {
    const r = parseVerifyReport(LINT_ASSIST.stdout, LINT_ASSIST.stderr);
    expect(r.passed).toBe(false);
    expect(r.parseFailed.lint).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      stage: 'lint',
      file: 'src\\cli\\slash\\agent.ts',
      line: 19,
      code: 'assist/source/organizeImports',
    });
  });

  it('整文件 format 错误（无行列号）→ 识别为 lint，file 有值、line 为空', () => {
    const r = parseVerifyReport(LINT_FORMAT_NO_LOC.stdout, LINT_FORMAT_NO_LOC.stderr);
    expect(r.passed).toBe(false);
    expect(r.parseFailed.lint).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      stage: 'lint',
      file: 'tests\\cli\\slash-agent.test.ts',
      code: 'format',
    });
    expect(r.errors[0]?.line).toBeUndefined();
  });

  it('lint 段多个不同类别错误（lint/assist/format）→ 全部识别', () => {
    const r = parseVerifyReport(
      [
        '> @concertoai/cli@4.1.0 lint',
        'src/a.ts:1:1  lint/style/noUnusedVariables  FIXABLE  ━━━',
        'src/b.ts:2:1  assist/source/organizeImports  FIXABLE  ━━━',
        'src/c.ts format ━━━',
        '  × Formatter would have printed the following content:',
        'Checked 3 files in 10ms. Found 3 errors.',
      ].join('\n'),
      '',
    );
    expect(r.passed).toBe(false);
    expect(r.errors).toHaveLength(3);
    const codes = r.errors.map((e) => e.code).sort();
    expect(codes).toEqual([
      'assist/source/organizeImports',
      'format',
      'lint/style/noUnusedVariables',
    ]);
  });

  // v3.2 M1 / T1.5：跨平台样本库双平台回归（AGENTS.md 自查第 10 条）
  it('样本库：Windows/POSIX Biome lint 错误均识别为 lint', () => {
    for (const [name, sample] of [
      ['win', BIOME_LINT_ERROR_WIN],
      ['posix', BIOME_LINT_ERROR_POSIX],
    ] as const) {
      const r = parseVerifyReport(`> @concertoai/cli@4.1.0 lint\n${sample}\n`, '');
      expect(r.passed).toBe(false);
      expect(r.parseFailed.lint).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatchObject({
        stage: 'lint',
        file: name === 'win' ? 'C:\\work\\demo\\src\\app.ts' : '/home/user/work/demo/src/app.ts',
        line: 5,
        code: 'lint/suspicious/noDebugger',
      });
    }
  });

  it('样本库：Windows format 无行列错误 / POSIX assist 错误均识别为 lint', () => {
    const win = parseVerifyReport(`> @concertoai/cli@4.1.0 lint\n${BIOME_FORMAT_ERROR_WIN}\n`, '');
    expect(win.parseFailed.lint).toBe(false);
    expect(win.errors[0]).toMatchObject({
      stage: 'lint',
      file: 'C:\\work\\demo\\src\\app.ts',
      code: 'format',
    });
    expect(win.errors[0]?.line).toBeUndefined();

    const posix = parseVerifyReport(
      `> @concertoai/cli@4.1.0 lint\n${BIOME_ASSIST_ERROR_POSIX}\n`,
      '',
    );
    expect(posix.parseFailed.lint).toBe(false);
    expect(posix.errors[0]).toMatchObject({
      stage: 'lint',
      file: '/home/user/work/demo/src/app.ts',
      line: 2,
      code: 'assist/source/organizeImports',
    });
  });

  it('样本库：Windows/POSIX tsc 错误均识别为 type 简单错误（TS2304）', () => {
    for (const [name, sample] of [
      ['win', TSC_ERROR_WIN],
      ['posix', TSC_ERROR_PRETTY_POSIX],
    ] as const) {
      const r = parseVerifyReport(`> @concertoai/cli@4.1.0 typecheck\n${sample}\n`, '');
      expect(r.passed).toBe(false);
      expect(r.parseFailed.type).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatchObject({
        stage: 'type',
        file: name === 'win' ? 'C:\\work\\demo\\src\\app.ts' : '/home/user/work/demo/src/app.ts',
        line: 10,
        code: 'TS2304',
      });
      const first = r.errors[0];
      expect(first).toBeDefined();
      if (first !== undefined) {
        expect(isSimpleTypeError(first)).toBe(true);
      }
    }
  });

  // T6.5 手工测试回归：tsc/Biome 错误写入 stderr（真实 npm run verify 行为），
  // 简单拼接 stdout+stderr 会把错误追加到最后一个段（test）→ 误判 passed=true
  it('tsc 错误写入 stderr → 识别为 type 段错误（T6.5：undefinedVariable 未检测回归）', () => {
    // stdout 4 段全部正常（含段标记），tsc 错误在 stderr（Windows 反斜杠相对路径）
    const stdout = [
      '> @concertoai/cli@4.1.0 build',
      'CLI Build success: 408 modules',
      '> @concertoai/cli@4.1.0 lint',
      'Checked 408 files in 2.3s. No errors found.',
      '> @concertoai/cli@4.1.0 typecheck',
      '> tsc --noEmit',
      '> @concertoai/cli@4.1.0 test',
      'Test Files  88 passed (88)',
      'Tests  1004 passed (1004)',
    ].join('\n');
    const stderr = "src\\foo.ts(2,10): error TS2304: Cannot find name 'undefinedVariable'.\n";
    const r = parseVerifyReport(stdout, stderr);
    expect(r.passed).toBe(false);
    expect(r.parseFailed.type).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      stage: 'type',
      file: 'src\\foo.ts',
      line: 2,
      code: 'TS2304',
    });
  });

  it('stderr 混合 tsc/Biome/vitest 错误 → 各自归段（T6.5）', () => {
    const stdout = [
      '> @concertoai/cli@4.1.0 build',
      'Build success.',
      '> @concertoai/cli@4.1.0 lint',
      '> @concertoai/cli@4.1.0 typecheck',
      '> @concertoai/cli@4.1.0 test',
    ].join('\n');
    const stderr = [
      'src\\a.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━',
      "src\\b.ts(3,4): error TS2304: Cannot find name 'undefinedVariable'.",
      'FAIL src/foo.test.ts',
      '  ✗ 测试失败',
      'AssertionError: expected 1 to be 2',
    ].join('\n');
    const r = parseVerifyReport(stdout, stderr);
    expect(r.passed).toBe(false);
    expect(r.errors.map((e) => e.stage).sort()).toEqual(['lint', 'test', 'type']);
    const typeErr = r.errors.find((e) => e.stage === 'type');
    expect(typeErr).toMatchObject({ file: 'src\\b.ts', line: 3, code: 'TS2304' });
  });

  it('build 段 tsup 失败 → stage=build（file/line 为空）', () => {
    const r = parseVerifyReport(BUILD_FAIL.stdout, BUILD_FAIL.stderr);
    expect(r.passed).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ stage: 'build' });
    expect(r.errors[0]?.file).toBeUndefined();
    expect(r.errors[0]?.line).toBeUndefined();
    expect(r.errors[0]?.message).toContain('RollupError');
  });

  it('test 段 vitest FAIL → stage=test + TEST_FAIL code', () => {
    const r = parseVerifyReport(TEST_FAIL.stdout, TEST_FAIL.stderr);
    expect(r.passed).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      stage: 'test',
      file: 'src/foo.test.ts',
      code: 'TEST_FAIL',
    });
    expect(r.errors[0]?.message).toContain('加法应该正确');
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

  // v3.2 M2 / T2.3：增量 verify——lint 修复后仅 rerun lint 段，通过则跳过全量
  it('增量 verify：lint 修复后 lint 段通过 → 不触发全量 verify（runVerify 0 次）', async () => {
    let verifyCalls = 0;
    let lintOnlyCalls = 0;
    const options: RepairVerifyOptions = {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'selfheal-')),
      runVerify: async () => {
        verifyCalls += 1;
        return LINT_FAIL;
      },
      runLintFix: async () => ({ ok: true }),
      runLintOnly: async () => {
        lintOnlyCalls += 1;
        return { stdout: 'All checks passed.', stderr: '' };
      },
      log: () => {},
    };
    const initial = parseVerifyReport(LINT_FAIL.stdout, LINT_FAIL.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(result.passed).toBe(true);
    // 增量：lint 修复后 lint 段通过 → mergeLintPassed 跳过全量，repair 内不再调 runVerify
    expect(verifyCalls).toBe(0);
    expect(lintOnlyCalls).toBe(1);
    expect(result.attempts[0]?.action).toBe('lint-fix');
  });

  it('对照：无 runLintOnly → lint 修复后走全量 verify（runVerify 1 次）', async () => {
    let verifyCalls = 0;
    let lintFixed = false;
    const options: RepairVerifyOptions = {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'selfheal-')),
      runVerify: async () => {
        verifyCalls += 1;
        return lintFixed ? VERIFY_PASS : LINT_FAIL;
      },
      runLintFix: async () => {
        lintFixed = true;
        return { ok: true };
      },
      log: () => {},
    };
    const initial = parseVerifyReport(LINT_FAIL.stdout, LINT_FAIL.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(result.passed).toBe(true);
    expect(verifyCalls).toBe(1); // 非增量：lint 修复后全量 verify 一次
  });

  it('增量 verify：lint 段仍未通过 → 回退全量 verify（runVerify 1 次）', async () => {
    let verifyCalls = 0;
    const options: RepairVerifyOptions = {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'selfheal-')),
      runVerify: async () => {
        verifyCalls += 1;
        return LINT_FAIL;
      },
      runLintFix: async () => ({ ok: true }),
      runLintOnly: async () => ({
        stdout: 'src/foo.ts:1:5  lint/suspicious/noExplicitAny  FIXABLE  ━━━',
        stderr: '',
      }),
      log: () => {},
    };
    const initial = parseVerifyReport(LINT_FAIL.stdout, LINT_FAIL.stderr);
    const result = await repairVerifyReport(initial, options);
    // lint 段仍失败 → lintOnly 不合并，回退全量 verify；全量也仍失败 → 第二轮再 lint → 超限
    expect(verifyCalls).toBeGreaterThanOrEqual(1);
    expect(result.passed).toBe(false);
    expect(result.exceeded).toBe(true);
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

  it('修复超限：连续失败达上限 → exceeded=true + 结构化反馈转人工', async () => {
    const original = `import { foo } from './foo';\n${FIX.search}\n`;
    const { cwd, fooPath } = await makeWorkspace(original);
    const snapshots = new SnapshotManager(cwd);
    const options: RepairVerifyOptions = {
      cwd,
      client: fakeClient(FIX.json),
      model: 'deepseek-test',
      requestApproval: () => true,
      snapshots,
      // 模型修复后 verify 始终报同一个错误（修复永远无效）
      runVerify: async () => TYPE_MISSING_IMPORT,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    };
    const initial = parseVerifyReport(TYPE_MISSING_IMPORT.stdout, TYPE_MISSING_IMPORT.stderr);
    const result = await repairVerifyReport(initial, options);
    expect(result.passed).toBe(false);
    expect(result.exceeded).toBe(true);
    // 尝试次数达到上限，每轮都是 model-fix 并回滚
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.action === 'model-fix')).toBe(true);
    expect(result.attempts.every((a) => a.rolledBack === true)).toBe(true);
    // 文件最终恢复到原状（每次回滚都成功）
    expect(await readFile(fooPath, 'utf8')).toBe(original);
    // 快照全部清理
    expect(await snapshots.list()).toEqual([]);
  });

  // v3.2 M2 / T2.4：快照登记失败 → snapshotWarning=true + 文件仍修复（放弃回滚保护继续写盘）
  it('快照登记失败 → snapshotWarning=true，文件仍被修复（回滚保护放弃）', async () => {
    const { cwd, fooPath } = await makeWorkspace(`import { foo } from './foo';\n${FIX.search}\n`);
    const snapshots = new SnapshotManager(cwd);
    // begin 抛错模拟快照目录不可写 → 快照登记失败
    const beginSpy = vi
      .spyOn(SnapshotManager.prototype, 'begin')
      .mockRejectedValue(new Error('snapshot dir unwritable'));
    try {
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
      expect(result.snapshotWarning).toBe(true);
      // 快照保护放弃但继续写盘 → 文件仍被修复且 verify 通过
      expect(result.passed).toBe(true);
      expect(await readFile(fooPath, 'utf8')).toContain(FIX.replace);
      // 快照未登记 → 无残留快照
      expect(await snapshots.list()).toEqual([]);
    } finally {
      beginSpy.mockRestore();
    }
  });

  it('快照登记正常 → snapshotWarning 不置位', async () => {
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
    expect(result.snapshotWarning).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(await readFile(fooPath, 'utf8')).toContain(FIX.replace);
    expect(await snapshots.list()).toEqual([]);
  });
});

// ── T1.4 触发入口 runSelfHeal ─────────────────────────────────

describe('self-heal 触发入口（T1.4）', () => {
  it('verify 通过 → passed=true、无尝试、报告含「无需修复」', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'selfheal-'));
    const result = await runSelfHeal({
      cwd,
      runVerify: async () => VERIFY_PASS,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    });
    expect(result.passed).toBe(true);
    expect(result.attempts).toHaveLength(0);
    expect(result.report.summary).toContain('无需修复');
  });

  it('verify 失败（lint）→ 自动 lint:fix → verify 通过', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'selfheal-'));
    let lintFixed = false;
    const result = await runSelfHeal({
      cwd,
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
  });

  it('无 client/model 时 type 简单错误 → 结构化反馈转人工（不崩溃）', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'selfheal-'));
    const result = await runSelfHeal({
      cwd,
      // 不传 client/model → 模型修复不可用
      runVerify: async () => TYPE_MISSING_IMPORT,
      runLintFix: async () => ({ ok: true }),
      log: () => {},
    });
    expect(result.passed).toBe(false);
    expect(result.exceeded).toBe(false);
    expect(result.attempts.length).toBeGreaterThan(0);
    // 结构化反馈包含「请手动」类建议
    const last = result.attempts.at(-1);
    expect(last?.feedback.some((f) => f.suggestion.includes('手动'))).toBe(true);
  });
});
