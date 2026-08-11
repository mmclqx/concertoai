/**
 * 跨平台解析样本库（v3.2 M1 / T1.5）。
 *
 * 供解析类测试（self-heal 分类器 / qa parseVerifyOutput / projects 路径规范化 /
 * error-codes 推断等）复用，强制 Windows + POSIX 双样本覆盖：
 * - Windows 反斜杠路径 / 盘符冒号 / UNC 网络共享；
 * - POSIX 绝对路径；
 * - CRLF / LF 换行变体；
 * - vitest 失败输出（Windows 盘符 + POSIX 双形态）。
 *
 * 使用原则（AGENTS.md 提交前自查第 10 条）：解析第三方工具输出的正则必须用
 * Windows 与 POSIX 两种样本验证，且覆盖类别/行列变体。
 */

// ── 路径样本 ──────────────────────────────────────────────────

/** Windows 反斜杠绝对路径（盘符）。 */
export const WIN_ABS_PATH = 'C:\\work\\demo\\src\\app.ts';
/** Windows 盘符路径的 POSIX 形态（反斜杠已转正斜杠）。 */
export const WIN_POSIX_PATH = 'C:/work/demo/src/app.ts';
/** POSIX 绝对路径。 */
export const POSIX_ABS_PATH = '/home/user/work/demo/src/app.ts';
/** Windows UNC 网络共享路径（反斜杠）。 */
export const UNC_ABS_PATH = '\\\\server\\share\\demo\\src\\app.ts';
/** Windows UNC 网络共享路径的 POSIX 形态。 */
export const UNC_POSIX_PATH = '//server/share/demo/src/app.ts';
/** Windows 盘符路径 + .. 归一化（反斜杠）。 */
export const WIN_DOTDOT_PATH = 'C:\\work\\demo\\..\\src\\app.ts';
/** POSIX 路径 + .. 归一化。 */
export const POSIX_DOTDOT_PATH = '/home/user/work/demo/../src/app.ts';

// ── 换行样本 ──────────────────────────────────────────────────

/** CRLF 换行（Windows 文件读取结果）。 */
export const CRLF_TEXT = 'line1\r\nline2\r\nline3\r\n';
/** LF 换行（POSIX 文件读取结果）。 */
export const LF_TEXT = 'line1\nline2\nline3\n';

// ── vitest 输出样本 ───────────────────────────────────────────

/** vitest 全绿输出（Windows 盘符 cwd）。 */
export const VITEST_PASS_WIN = [
  ' RUN  v4.1.10 F:/developer/2026/concertoai',
  '',
  ' Test Files  51 passed (51)',
  '      Tests  577 passed (577)',
  '   Duration 3.62s',
].join('\n');

/** vitest 失败输出（Windows 盘符路径失败文件）。 */
export const VITEST_FAIL_WIN = [
  ' RUN  v4.1.10',
  '',
  ' ❯ C:\\work\\demo\\tests\\foo.test.ts (3 tests | 1 failed) 123ms',
  '   ✓ 正常用例 1',
  '   ✗ 失败用例',
  '     AssertionError: expected 1 to be 2',
  '     ❯ C:\\work\\demo\\tests\\foo.test.ts:10:5',
  '',
  ' Test Files  1 failed (51)',
  '      Tests  1 failed (577)',
].join('\n');

/** vitest 失败输出（POSIX 路径失败文件）。 */
export const VITEST_FAIL_POSIX = [
  ' RUN  v4.1.10',
  '',
  ' ❯ /home/user/work/demo/tests/foo.test.ts (3 tests | 1 failed) 123ms',
  '   ✓ 正常用例 1',
  '   ✗ 失败用例',
  '     AssertionError: expected 1 to be 2',
  '     ❯ /home/user/work/demo/tests/foo.test.ts:10:5',
  '',
  ' Test Files  1 failed (51)',
  '      Tests  1 failed (577)',
].join('\n');

/** vitest 失败输出（FAIL 前缀形态，Windows 盘符）。 */
export const VITEST_FAIL_PREFIX_WIN = [
  ' RUN  v4.1.10',
  '',
  ' FAIL C:\\work\\demo\\tests\\bar.spec.ts',
  '   × 另一个失败',
  '     Error: boom',
  '',
  ' Test Files  1 failed (51)',
  '      Tests  1 failed (577)',
].join('\n');

/** vitest 失败输出（POSIX 双失败文件 + ❯/× 混合形态；qa 存量测试迁移，v3.3 S2）。 */
export const VITEST_FAIL_MIXED_POSIX = [
  ' RUN  v4.1.10',
  '',
  ' ❯ tests/foo.test.ts (3 tests | 1 failed) 123ms',
  '   ✓ 正常用例 1',
  '   ✗ 失败用例',
  '     AssertionError: expected 1 to be 2',
  '     ❯ tests/foo.test.ts:10:5',
  ' ❯ tests/bar.spec.ts (1 test | 1 failed) 5ms',
  '   × 另一个失败',
  '     Error: boom',
  '',
  ' Test Files  1 failed (51)',
  '      Tests  2 failed (577)',
].join('\n');

// ── Biome / tsc 输出样本 ──────────────────────────────────────

/** Biome lint 错误（Windows 盘符路径，带行列）。 */
export const BIOME_LINT_ERROR_WIN =
  'C:\\work\\demo\\src\\app.ts:5:1 lint/suspicious/noDebugger  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━';

/** Biome lint 错误（POSIX 路径）。 */
export const BIOME_LINT_ERROR_POSIX =
  '/home/user/work/demo/src/app.ts:5:1 lint/suspicious/noDebugger  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━';

/** Biome format 错误（Windows 盘符路径，无行列——format 行列可选的变体）。 */
export const BIOME_FORMAT_ERROR_WIN =
  'C:\\work\\demo\\src\\app.ts format  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━';

/** Biome assist/organizeImports 错误（POSIX 路径）。 */
export const BIOME_ASSIST_ERROR_POSIX =
  '/home/user/work/demo/src/app.ts:2:1 assist/source/organizeImports  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━';

/** tsc 标准错误（Windows 盘符路径）。 */
export const TSC_ERROR_WIN =
  "C:\\work\\demo\\src\\app.ts:10:5 - error TS2304: Cannot find name 'foo'.";

/** tsc pretty 错误（POSIX 路径）。 */
export const TSC_ERROR_PRETTY_POSIX =
  '/home/user/work/demo/src/app.ts:10:5 - error TS2304: Cannot find name foo.';
