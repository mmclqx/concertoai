#!/usr/bin/env node
/**
 * 阻止「整个测试文件被静默跳过」（v5.0 T22）。
 *
 * ## 为什么需要这个脚本
 *
 * vitest 对两类「没有真在跑的测试」处理完全不同：
 * - **空文件（0 字节）** → 报 `No test suite found in file` 并计入 `Failed Suites`，
 *   `npm run verify` 直接红（`vitest.config.ts` 未设 `passWithNoTests`）。**能自动发现**。
 * - **整篇 `it.skip` / `it.todo`** → 只报 `skipped`，run 仍然**成功**。
 *   文件看起来「在」，实际一条断言都没跑。**静默通过 = 假绿**。
 *
 * 第二类是真实的盲区：把某个测试文件整体 `.skip` 掉（临时排查、等 bug 修完再开）
 * 然后忘记恢复，CI 依然全绿，覆盖率悄悄下降且无人察觉。本脚本把它变成硬失败。
 *
 * ## 判据（刻意保守，不误报）
 *
 * 只统计**测试用例声明**（`it(` / `test(` 及其链式变体），不含 `describe(`——`describe`
 * 只是容器，`describe.skip` 包住真实 `it` 时下面仍有用例，不算「空文件」。
 *
 * - 文件里 **0 条用例声明** → 也算失败（与 vitest 的空文件报错同向，但给出更清楚的提示）
 * - 有声明但**全部**是 `.skip` / `.todo` / `xit` / `xtest` → 失败
 * - 至少 1 条真在跑 → 通过
 *
 * 扫描前先剥掉注释：注释里写 `it(` 之类说明文字不该被判成用例（历史踩坑：
 * 裸正则不看上下文，导致护栏自己误报，见 09-踩坑记录）。
 *
 * ## 用法
 *
 *   node scripts/check-skipped-tests.mjs          # 发现问题 → exit 1
 *   node scripts/check-skipped-tests.mjs --list   # 只打印统计，不因违规退出
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TESTS_DIR = path.join(ROOT, 'tests');
/** 测试文件匹配（与 vitest.config.ts 的 include 保持一致）。 */
const TEST_FILE_RE = /\.test\.(ts|tsx)$/;
/** 只打印统计、不因违规失败（本地排查用）。 */
const LIST_ONLY = process.argv.includes('--list');

/** 递归收集测试文件。 */
function collectTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(full));
    } else if (TEST_FILE_RE.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

/**
 * 剥掉注释（块注释 + 行注释），保留字符串内容。
 *
 * 顺序要紧：先去掉块注释再去行注释，否则 `//` 出现在块注释里会提前截断。
 * 字符串里的 `//`（如 URL）不受影响——行注释只在**行首或代码后**出现，
 * 而本函数按「`//` 前不是字符串定界符」粗判，测试文件里够用（宁少剥不误剥）。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * 统计一个文件里的用例声明。
 *
 * `(?:\.\w+)*` 吃掉链式修饰（`.skip` / `.todo` / `.each` / `.concurrent` /
 * `.skipIf(...)` 等），再判断修饰里有没有 skip/todo。
 */
function analyze(source) {
  const code = stripComments(source);
  const decls = [];
  const declRe = /\b(it|test)((?:\.\w+)*)\s*\(/g;
  for (const match of code.matchAll(declRe)) {
    decls.push(match[2] ?? '');
  }
  // `xit(` / `xtest(`：老式跳过写法（无点链）
  const xRe = /\bx(it|test)\s*\(/g;
  let legacySkipped = 0;
  for (const _ of code.matchAll(xRe)) {
    legacySkipped += 1;
  }
  const isSkipped = (modifiers) => /\.(skip|todo)\b/.test(modifiers);
  const skipped = decls.filter(isSkipped).length + legacySkipped;
  const active = decls.filter((m) => !isSkipped(m)).length;
  return { total: decls.length + legacySkipped, active, skipped };
}

const files = collectTestFiles(TESTS_DIR);
const problems = [];
let skippedFiles = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const { total, active, skipped } = analyze(readFileSync(file, 'utf8'));
  if (skipped > 0) {
    skippedFiles += 1;
  }
  if (active === 0) {
    problems.push({
      file: rel,
      reason:
        total === 0
          ? '没有找到任何用例声明（it / test）——文件形同虚设'
          : `${total} 条用例声明全部被跳过（skip / todo），实际一条断言都不会跑`,
    });
  }
}

if (LIST_ONLY) {
  console.log(`扫描 ${files.length} 个测试文件；含跳过用例的文件 ${skippedFiles} 个（不影响通过）。`);
}

if (problems.length === 0) {
  console.log(
    `✅ 跳过检测通过：${files.length} 个测试文件都有真在跑的用例` +
      (skippedFiles > 0 ? `（其中 ${skippedFiles} 个含部分 .skip/.todo，属正常）` : ''),
  );
  process.exit(0);
}

console.error(`❌ 发现 ${problems.length} 个测试文件「一条用例都不会跑」：`);
for (const problem of problems) {
  console.error(`  - ${problem.file}`);
  console.error(`    原因：${problem.reason}`);
}
console.error('');
console.error('为什么这是失败而不是警告：vitest 对全 skip / todo 的文件只报 skipped，');
console.error('run 依然成功——文件看着还在，覆盖率却悄悄归零，无人察觉。');
console.error('若确实要临时停用，请在本条脚本里显式加白名单并写清原因与恢复条件。');
process.exit(1);
