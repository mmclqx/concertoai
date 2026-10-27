/**
 * 审批洞察基准脚本（v5.0 T8.5 发布门，硬指标）。
 *
 * 跑法：`npm run build && node scripts/bench-approval.mjs`
 * （必须用 dist——测的是用户实际跑的构建产物，不是 tsx 直译的源码）
 *
 * 覆盖 T8.5 全部 6 项预算：
 * | 项 | 预算 |
 * |---|---|
 * | analyzeDiff（100 行 × 15 规则） | < 5ms |
 * | analyzeDiff（500 行上限） | < 20ms |
 * | 单条规则（10 万字符长行，W8 防 ReDoS） | < 20ms |
 * | analyzeImpact（200 文件项目） | < 80ms |
 * | 审批框出现 P95（analyzeApproval 带真实 IO） | < 150ms |
 * | 审批框出现最坏（大项目 + 超时路径） | < 400ms |
 *
 * 任何一项超标 → 退出码 1（发布门自动化，不靠感觉）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  analyzeApproval,
  analyzeDiff,
  clearImpactCache,
  IMPACT_LIMITS,
  RISK_RULES,
  scanImpact,
} from '../dist/index.js';

/** 预算表（与任务书 T8.5 逐行对应，改数字前先改任务书）。 */
const BUDGETS = {
  diff100: 5,
  diff500: 20,
  oneRuleLongLine: 20,
  impact200: 80,
  approvalP95: 150,
  approvalWorst: 400,
};

/** 构造 n 行 diff。 */
function makeDiff(lines) {
  return ['@@ -1,3 +1,3 @@', ...lines].join('\n');
}

/** 5 类典型 diff（对齐真实审批场景）。 */
const CASES = {
  '小改（3 行无害）': makeDiff(['+const a = 1;', '+const b = 2;', '+return a + b;']),
  '删文件（高危）': makeDiff(['+await fs.rm(dir, { recursive: true });']),
  '改超时（中危）': makeDiff([
    '-  setTimeout(() => ctrl.abort(), 5000);',
    '+  setTimeout(() => ctrl.abort(), 10000);',
  ]),
  '删错误分支（高危）': makeDiff(['-    throw new Error("failed");', '-  } catch (e) {']),
  '100 行混合（常态）': makeDiff(
    Array.from({ length: 100 }, (_, i) =>
      i % 10 === 0 ? `+const v${i} = process.env.X${i};` : `+const v${i} = ${i};`,
    ),
  ),
};

/** 取分位数。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/** 行内格式：P50 / P95 / max。 */
function fmt(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return `P50 ${percentile(sorted, 0.5).toFixed(3)}ms | P95 ${percentile(sorted, 0.95).toFixed(3)}ms | max ${(sorted.at(-1) ?? 0).toFixed(3)}ms`;
}

/** 发布门记账（超标不中断，全部跑完后统一判定，便于一次看全）。 */
const gates = [];
function record(name, actualMs, budgetMs, note = '') {
  const passed = actualMs <= budgetMs;
  gates.push({ name, actualMs, budgetMs, passed, note });
  const mark = passed ? '✅' : '❌';
  console.log(
    `${mark} ${name.padEnd(30)} ${actualMs.toFixed(2).padStart(8)}ms / 预算 ${String(budgetMs).padStart(3)}ms${note === '' ? '' : `  （${note}）`}`,
  );
}

// ────────────────────────────────────────────────────────────
// ① analyzeDiff：5 类典型 diff × 100 次
// ────────────────────────────────────────────────────────────
console.log('=== ① analyzeDiff 基准（100 次/用例）===');
const diffSamples = new Map();
for (const [name, detail] of Object.entries(CASES)) {
  const samples = [];
  let hitCount = 0;
  for (let i = 0; i < 100; i += 1) {
    const started = performance.now();
    hitCount = analyzeDiff(detail, RISK_RULES).length;
    samples.push(performance.now() - started);
  }
  diffSamples.set(name, samples);
  console.log(
    `${name.padEnd(22)} 命中 ${String(hitCount).padStart(2)} 条 | ${fmt(samples)}`,
  );
}
record(
  'analyzeDiff(100 行×15 规则) P95',
  percentile(
    [...diffSamples.get('100 行混合（常态）')].sort((a, b) => a - b),
    0.95,
  ),
  BUDGETS.diff100,
);
console.log('');

// ────────────────────────────────────────────────────────────
// ② analyzeDiff：500 行上限（超过不做逐行分析前的天花板）
// ────────────────────────────────────────────────────────────
console.log('=== ② analyzeDiff 500 行基准（50 次）===');
const diff500 = makeDiff(
  Array.from({ length: 500 }, (_, i) =>
    i % 25 === 0 ? `+  await fetch(url${i}, { timeout: ${i} });` : `+const v${i} = ${i};`,
  ),
);
const samples500 = [];
for (let i = 0; i < 50; i += 1) {
  const started = performance.now();
  analyzeDiff(diff500, RISK_RULES);
  samples500.push(performance.now() - started);
}
console.log(`500 行 diff：${fmt(samples500)}`);
record(
  'analyzeDiff(500 行) P95',
  percentile([...samples500].sort((a, b) => a - b), 0.95),
  BUDGETS.diff500,
);
console.log('');

// ────────────────────────────────────────────────────────────
// ③ 单条规则 × 10 万字符长行（W8 防 ReDoS：prefilter 失效时正则本身也要扛住）
//    ——长行里塞满该规则的 prefilter 特征，确保正则真的在 10 万字符上跑，而不是被子串粗筛跳过
// ────────────────────────────────────────────────────────────
console.log('=== ③ 单条规则 10 万字符长行（每规则 10 次）===');
const LONG = 100_000;
const ruleTimings = [];
for (const rule of RISK_RULES) {
  const trigger = rule.prefilter?.[0] ?? '';
  // 前后各 5 万字符 + 触发特征：正则要在长串上真正执行（这是 ReDoS 的真实考验）
  const line = `+${'a'.repeat(LONG / 2)}${trigger}${'a'.repeat(LONG / 2)}`;
  const per = [];
  for (let i = 0; i < 10; i += 1) {
    const started = performance.now();
    analyzeDiff(line, [rule]);
    per.push(performance.now() - started);
  }
  ruleTimings.push({ id: rule.id, max: Math.max(...per) });
}
ruleTimings.sort((a, b) => b.max - a.max);
const worst = ruleTimings[0] ?? { id: '无', max: 0 };
const worstRuleMs = worst.max;
const worstRuleId = worst.id;
console.log(
  `最慢 3 条：${ruleTimings
    .slice(0, 3)
    .map((t) => `${t.id} ${t.max.toFixed(3)}ms`)
    .join(' · ')}（${RISK_RULES.length} 条规则逐条测）`,
);
record('单规则(10 万字符长行) max', worstRuleMs, BUDGETS.oneRuleLongLine, worstRuleId);
console.log('');

// ────────────────────────────────────────────────────────────
// ④+⑤ 200 文件虚拟项目：analyzeImpact 与「审批框出现」端到端
// ────────────────────────────────────────────────────────────
function buildVirtualProject(fileCount = 200) {
  const root = mkdtempSync(path.join(tmpdir(), 'concerto-bench-'));
  const target = path.join(root, 'src', 'core', 'target.ts');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    'export function targetFn() {\n  return 1;\n}\nexport const TARGET_VALUE = 1;\n',
  );
  for (let i = 0; i < fileCount - 1; i += 1) {
    const dir = path.join(root, 'src', `mod${i % 10}`);
    mkdirSync(dir, { recursive: true });
    // 每 20 个文件里有 1 个引用 target → 200 文件项目约 10 个引用者（真实常态）
    const body =
      i % 20 === 0
        ? `import { targetFn } from '../core/target';\n\nexport function fn${i}() {\n  return targetFn() + ${i};\n}\n`
        : `export function fn${i}(x: number) {\n  return x + ${i};\n}\n`;
    writeFileSync(path.join(dir, `f${i}.ts`), body);
  }
  return { root, target, fileCount };
}

const project = buildVirtualProject(200);
clearImpactCache();
console.log(`=== ④ analyzeImpact 基准（${project.fileCount} 文件虚拟项目，缓存禁用，10 次）===`);
const impactSamples = [];
let lastImpact;
for (let i = 0; i < 10; i += 1) {
  const started = performance.now();
  // cacheTtlMs: 0 —— 测真实冷扫描成本（开缓存会把第 2 次之后测成 0ms，等于自欺）
  lastImpact = await scanImpact({ file: project.target, cwd: project.root, cacheTtlMs: 0 });
  impactSamples.push(performance.now() - started);
}
console.log(
  `${fmt(impactSamples)} | 扫描 ${lastImpact.scannedCount} 文件，引用 ${lastImpact.referenceCount} 个，status=${lastImpact.status}`,
);
record(
  'analyzeImpact(200 文件) max',
  Math.max(...impactSamples),
  BUDGETS.impact200,
);
console.log('');

console.log('=== ⑤ 审批框出现（analyzeApproval 带真实 IO，20 次冷扫描）===');
const approvalSamples = [];
let lastInsight;
for (let i = 0; i < 20; i += 1) {
  const started = performance.now();
  lastInsight = await analyzeApproval(CASES['删文件（高危）'], {
    isTTY: true,
    isCI: false,
    file: project.target,
    cwd: project.root,
    impact: { cacheTtlMs: 0 },
  });
  approvalSamples.push(performance.now() - started);
}
console.log(
  `${fmt(approvalSamples)} | level=${lastInsight.level} | impact=${lastInsight.impact.status}/${lastInsight.impact.referenceCount} 引用`,
);
const approvalP95 = percentile([...approvalSamples].sort((a, b) => a - b), 0.95);
record('analyzeApproval(真实 IO) P95', approvalP95, BUDGETS.approvalP95);

console.log('\n=== ⑥ 最坏路径与降级路径 ===');
record(
  'analyzeApproval(真实 IO) max',
  Math.max(...approvalSamples),
  BUDGETS.approvalWorst,
  '最坏 = 大项目冷扫描',
);

// 超时路径：给 1ms 预算，必然超时 → 必须立刻返回部分结果，绝不能拖到 300ms 之外
const timeoutStarted = performance.now();
const timeoutInsight = await analyzeApproval(CASES['删文件（高危）'], {
  isTTY: true,
  isCI: false,
  file: project.target,
  cwd: project.root,
  impact: { timeoutMs: 1, cacheTtlMs: 0 },
});
const timeoutMs = performance.now() - timeoutStarted;
record('审批超时路径（timeoutMs=1）', timeoutMs, BUDGETS.approvalWorst, `impact=${timeoutInsight.impact.status}`);

// 超大 diff：> 500 行不做逐行分析，必须秒回
const hugeDiff = makeDiff(Array.from({ length: 600 }, (_, i) => `+const v${i} = ${i};`));
const hugeStarted = performance.now();
const hugeInsight = await analyzeApproval(hugeDiff, { isTTY: true, isCI: false });
const hugeMs = performance.now() - hugeStarted;
record('超大 diff（600 行）降级', hugeMs, 5, `degradeReason=${hugeInsight.degradeReason ?? '无'}`);

console.log('\n=== ⑦ analyzeApproval 无 IO 基线（skipImpact，50 次；对照用）===');
const noIoSamples = [];
for (let i = 0; i < 50; i += 1) {
  const started = performance.now();
  await analyzeApproval(CASES['100 行混合（常态）'], { isTTY: true, isCI: false, skipImpact: true });
  noIoSamples.push(performance.now() - started);
}
console.log(fmt(noIoSamples));

rmSync(project.root, { recursive: true, force: true });
clearImpactCache();

// ────────────────────────────────────────────────────────────
// 汇总判定（发布门）
// ────────────────────────────────────────────────────────────
const failed = gates.filter((g) => !g.passed);
console.log(`\n=== 发布门判定：${gates.length - failed.length}/${gates.length} 项达标 ===`);
if (failed.length > 0) {
  for (const gate of failed) {
    console.log(`❌ ${gate.name}: ${gate.actualMs.toFixed(2)}ms > 预算 ${gate.budgetMs}ms`);
  }
  console.log('（IMPACT_LIMITS 当前值：' + JSON.stringify(IMPACT_LIMITS) + '）');
  process.exitCode = 1;
} else {
  console.log('全部达标 ✅（判据来源：v5.0 任务书 T8.5 性能预算表）');
}
