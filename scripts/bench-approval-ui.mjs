/**
 * 审批 UI 基准脚本（v5.0 T9.3 发布门，硬指标）。
 *
 * 跑法：`npm run build && node scripts/bench-approval-ui.mjs`（或 `npm run bench:approval-ui`）
 *
 * ## 为什么要单独一个脚本
 *
 * T8 的 14.59ms P95 只覆盖「分析」。T9 把分析结果搬上屏幕后，真正的口径是
 * **用户按下 y 之前那一屏要多久出现**——它 = 分析 + 文案生成 + Ink 首帧。
 * 这里把三段分别计时，超标一眼能看出是哪一段退化的（而不是只知道「慢了」）。
 *
 * | 段 | 预算 | 说明 |
 * |---|---|---|
 * | 分析（analyzeApproval，含影响面扫描） | T8 预算 150ms（P95） | 见 scripts/bench-approval.mjs |
 * | 文案（renderApprovalLines，纯字符串） | < 10ms | 纯函数，不该成为瓶颈 |
 * | **Ink 首帧（render → 第一帧可见）** | **P95 < 150ms / 最坏 < 400ms** | T9 验收原文 |
 * | 默认折叠视图 diff 行数 | ≤ 12 行 | 性能红线③（不许吃掉 T8 优势） |
 *
 * 任何一项超标 → 退出码 1（发布门自动化，不靠感觉）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import React from 'react';
import { render } from 'ink-testing-library';

import { analyzeApproval, clearImpactCache, renderApprovalLines } from '../dist/index.js';
import { ApprovalModal } from '../dist/ui/modals.js';

/** 预算表（与任务书 T9.3 / T9 验收逐行对应，改数字前先改任务书）。 */
const BUDGETS = {
  textMs: 10,
  inkFirstFrameP95: 150,
  inkFirstFrameWorst: 400,
  collapsedDiffLines: 12,
};

/** 构造 n 行 diff。 */
function makeDiff(lines) {
  return ['@@ -1,3 +1,3 @@', ...lines].join('\n');
}

/** 5 类典型审批 diff（与 T8 基准同源，便于横向对比）。 */
const CASES = [
  {
    name: '小改（3 行无害）',
    detail: makeDiff(['+const a = 1;', '+const b = 2;', '+return a + b;']),
  },
  {
    name: '删文件（高危）',
    detail: makeDiff(['+await fs.rm(dir, { recursive: true });']),
  },
  {
    name: '改超时（中危，易误报规则）',
    detail: makeDiff([
      '-  setTimeout(() => ctrl.abort(), 5000);',
      '+  setTimeout(() => ctrl.abort(), 10000);',
    ]),
  },
  {
    name: '100 行混合（常态）',
    detail: makeDiff(
      Array.from({ length: 100 }, (_, i) =>
        i % 10 === 0 ? `+const v${i} = process.env.X${i};` : `+const v${i} = ${i};`,
      ),
    ),
  },
  {
    name: '500 行（分析上限）',
    detail: makeDiff(Array.from({ length: 500 }, (_, i) => `+const v${i} = ${i};`)),
  },
];

/** 构造 200 文件虚拟项目（与 T8 基准同规模，影响面扫描才有真实 IO）。 */
function makeProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'concertoai-bench-ui-'));
  const src = path.join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(
    path.join(src, 'target.ts'),
    'export const targetFn = () => 1;\nexport const otherFn = () => 2;\n',
    'utf8',
  );
  for (let i = 0; i < 199; i += 1) {
    const body =
      i % 50 === 0
        ? "import { targetFn } from './target';\nexport const v = targetFn();\n"
        : `export const v${i} = ${i};\n`;
    writeFileSync(path.join(src, `file${i}.ts`), body, 'utf8');
  }
  return { root, target: path.join(src, 'target.ts') };
}

/** 取分位数。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

const ROUNDS = 25;
const project = makeProject();
const gates = [];

console.log(`=== 审批 UI 基准（每场景 ${ROUNDS} 次）===`);
console.log(`项目：200 文件（${project.root}）\n`);

for (const benchCase of CASES) {
  const textSamples = [];
  const inkSamples = [];
  const totalSamples = [];
  let collapsedDiffLines = 0;
  let analysisP95 = 0;

  for (let round = 0; round < ROUNDS; round += 1) {
    // ① 分析（含真实影响面扫描；缓存会命中，与用户「连续编辑同一文件」场景一致）
    const analysisStarted = performance.now();
    const insight = await analyzeApproval(benchCase.detail, {
      isTTY: true,
      isCI: false,
      file: project.target,
      cwd: project.root,
    });
    const analysisMs = performance.now() - analysisStarted;

    // ② 文案（纯字符串层）
    const textStarted = performance.now();
    const lines = renderApprovalLines({
      kind: 'edit',
      summary: '编辑文件 src/target.ts',
      detail: benchCase.detail,
      insight,
      intent: 'modify',
      ruleCount: 15,
    });
    textSamples.push(performance.now() - textStarted);
    collapsedDiffLines = Math.max(
      collapsedDiffLines,
      lines.filter((line) =>
        ['diff-add', 'diff-del', 'diff-hunk', 'diff-context'].includes(line.role),
      ).length,
    );

    // ③ Ink 首帧（从调用 render 到第一帧可读）
    const inkStarted = performance.now();
    const app = render(
      React.createElement(ApprovalModal, {
        kind: 'edit',
        summary: '编辑文件 src/target.ts',
        detail: benchCase.detail,
        insight,
        intent: 'modify',
        ruleCount: 15,
        width: 76,
      }),
    );
    const frame = app.lastFrame() ?? '';
    inkSamples.push(performance.now() - inkStarted);
    app.unmount();
    if (frame.length === 0) {
      console.log(`⚠️ ${benchCase.name}：Ink 首帧为空（渲染失败？）`);
    }

    totalSamples.push(analysisMs + textSamples.at(-1) + inkSamples.at(-1));
    if (round === 0) {
      analysisP95 = analysisMs;
    }
  }

  textSamples.sort((a, b) => a - b);
  inkSamples.sort((a, b) => a - b);
  totalSamples.sort((a, b) => a - b);
  const inkP95 = percentile(inkSamples, 0.95);
  const inkWorst = inkSamples.at(-1) ?? 0;

  console.log(`【${benchCase.name}】`);
  console.log(
    `  文案生成  P50 ${percentile(textSamples, 0.5).toFixed(2)}ms  P95 ${percentile(textSamples, 0.95).toFixed(2)}ms`,
  );
  console.log(
    `  Ink 首帧  P50 ${percentile(inkSamples, 0.5).toFixed(2)}ms  P95 ${inkP95.toFixed(2)}ms  最坏 ${inkWorst.toFixed(2)}ms`,
  );
  console.log(
    `  端到端(分析+文案+首帧)  P50 ${percentile(totalSamples, 0.5).toFixed(2)}ms  P95 ${percentile(totalSamples, 0.95).toFixed(2)}ms`,
  );
  console.log(`  折叠态 diff 行数：${collapsedDiffLines} 行（红线 ≤ ${BUDGETS.collapsedDiffLines}）`);
  if (analysisP95 > 0.01) {
    console.log(`  （首轮分析含冷启动：${analysisP95.toFixed(2)}ms）`);
  }
  console.log('');

  gates.push({ name: `${benchCase.name} · 文案 P95`, actual: percentile(textSamples, 0.95), budget: BUDGETS.textMs });
  gates.push({ name: `${benchCase.name} · Ink 首帧 P95`, actual: inkP95, budget: BUDGETS.inkFirstFrameP95 });
  gates.push({
    name: `${benchCase.name} · Ink 首帧最坏`,
    actual: inkWorst,
    budget: BUDGETS.inkFirstFrameWorst,
  });
  gates.push({
    name: `${benchCase.name} · 折叠行数`,
    actual: collapsedDiffLines,
    budget: BUDGETS.collapsedDiffLines,
  });
}

// ────────────────────────────────────────────────────────────
// 非 TTY / plain 降级路径：绝不比 rich 慢（它就是 3 行文本）
// ────────────────────────────────────────────────────────────
const plainSamples = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const started = performance.now();
  const lines = renderApprovalLines({
    kind: 'edit',
    summary: '编辑文件 src/target.ts',
    detail: makeDiff(Array.from({ length: 500 }, (_, i) => `+const v${i} = ${i};`)),
    insight: null,
    width: 76,
  });
  if (lines.length !== 3) {
    console.log('⚠️ plain 路径行数不是 3（v4.1.1 原貌被破坏）');
  }
  plainSamples.push(performance.now() - started);
}
plainSamples.sort((a, b) => a - b);
console.log('=== plain 降级路径（insight=null，非 TTY / CI 走这里）===');
console.log(`  P50 ${percentile(plainSamples, 0.5).toFixed(3)}ms  P95 ${percentile(plainSamples, 0.95).toFixed(3)}ms`);
gates.push({ name: 'plain 路径 P95', actual: percentile(plainSamples, 0.95), budget: 5 });

rmSync(project.root, { recursive: true, force: true });
clearImpactCache();

// ────────────────────────────────────────────────────────────
// 汇总判定（发布门）
// ────────────────────────────────────────────────────────────
const failed = gates.filter((gate) => gate.actual > gate.budget);
console.log(`\n=== 发布门判定：${gates.length - failed.length}/${gates.length} 项达标 ===`);
if (failed.length > 0) {
  for (const gate of failed) {
    console.log(`❌ ${gate.name}: ${gate.actual.toFixed(2)} > 预算 ${gate.budget}`);
  }
  process.exitCode = 1;
} else {
  console.log('全部达标 ✅（判据来源：v5.0 任务书 T9.3 性能红线 + T9 验收「modal 首帧 P95 < 150ms」）');
}
