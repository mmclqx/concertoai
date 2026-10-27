/**
 * 误报率实测脚本（v5.0 T8.6 验收 R2，发布门）。
 *
 * 跑法：`npm run build && node scripts/verify-false-positive.mjs`
 * （必须用 dist——测的是用户实际跑的构建产物）
 *
 * 两部分：
 * ① **标注样本判定（发布门）**：`tests/fixtures/approval/` 的 manifest 里每条样本都有人工标注
 *    （`risk` / `no-risk` + 理由），逐条算命中 → 输出误报率 / 召回率明细表。
 *    判据：no-risk 误报 ≤ 1 条 且 < 5%；high 级误报 = 0；risk 样本声明规则 100% 命中。
 * ② **git 历史分布（补充观察）**：从本项目最近提交里取 40 段真实 hunk，看命中分布，
 *    用于发现「某条规则在真实代码里高频刷屏」这类问题（人工看，不计入发布门）。
 *
 * 不达标 → 退出码 1（发布门自动化，不靠感觉）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { analyzeDiff, RISK_RULES } from '../dist/index.js';

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'approval');

/** 读 manifest（标注的唯一来源）。 */
function loadManifest() {
  const raw = readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8');
  return JSON.parse(raw).samples;
}

/** 对齐宽度的中文友好 padding（中文算 2 列）。 */
function pad(text, width) {
  let w = 0;
  for (const ch of text) {
    w += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - w));
}

// ────────────────────────────────────────────────────────────
// ① 标注样本判定（发布门）
// ────────────────────────────────────────────────────────────
const samples = loadManifest();
const onDisk = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.diff')).sort();
const missing = onDisk.filter((name) => !samples.some((s) => s.file === name));
const ghost = samples.filter((s) => !onDisk.includes(s.file));

console.log(`=== ① 标注样本判定（${samples.length} 条真实 edit diff，规则表 ${RISK_RULES.length} 条）===`);
console.log(
  `${pad('#', 4)}${pad('样本', 34)}${pad('标注', 8)}${pad('命中', 30)}判定`,
);
console.log('-'.repeat(96));

const falsePositives = [];
const highFalsePositives = [];
const misses = [];
let idx = 0;
for (const sample of samples) {
  idx += 1;
  const diff = readFileSync(path.join(FIXTURE_DIR, sample.file), 'utf8');
  const hits = analyzeDiff(diff, RISK_RULES);
  const ruleIds = hits.map((hit) => hit.ruleId);
  let verdict;
  if (sample.label === 'risk') {
    const expected = sample.expectRules ?? [];
    const lacking = expected.filter((ruleId) => !ruleIds.includes(ruleId));
    if (lacking.length === 0) {
      verdict = '✅ 真风险命中（符合标注）';
    } else {
      misses.push(`${sample.file} 漏 ${lacking.join(',')}`);
      verdict = `❌ 漏报（缺 ${lacking.join(',')}）`;
    }
  } else if (hits.length === 0) {
    verdict = '✅ 无风险且零命中';
  } else {
    falsePositives.push(`${sample.file} → ${ruleIds.join(',')}`);
    if (hits.some((hit) => hit.level === 'high')) {
      highFalsePositives.push(sample.file);
    }
    verdict = '❌ 误报';
  }
  const hitText =
    hits.length === 0
      ? '—'
      : hits.map((hit) => `${hit.ruleId}/${hit.level}`).join(', ');
  console.log(`${pad(String(idx), 4)}${pad(sample.file, 34)}${pad(sample.label, 8)}${pad(hitText, 30)}${verdict}`);
}

const noRisk = samples.filter((s) => s.label === 'no-risk');
const riskSamples = samples.filter((s) => s.label === 'risk');
const fpRate = noRisk.length === 0 ? 0 : (falsePositives.length / noRisk.length) * 100;
const recallOk = misses.length === 0;

console.log('\n=== 误报率 / 召回率汇总 ===');
console.log(`样本总数 ${samples.length}（risk ${riskSamples.length} / no-risk ${noRisk.length}）`);
console.log(
  `误报 ${falsePositives.length} 条 / no-risk ${noRisk.length} 条 = ${fpRate.toFixed(1)}%（判据 ≤1 条且 <5%）`,
);
console.log(`high 级误报 ${highFalsePositives.length} 条（判据 = 0，狼来了防线）`);
console.log(`漏报 ${misses.length} 条（判据 = 0，标注 risk 的声明规则必须命中）`);
if (falsePositives.length > 0) {
  for (const item of falsePositives) console.log(`  误报明细：${item}`);
}
if (ghost.length > 0 || missing.length > 0) {
  console.log(`  ⚠️ manifest 与磁盘不一致：manifest 多 ${ghost.length} 条 / 磁盘多 ${missing.length} 条`);
}

const gatePassed =
  falsePositives.length <= 1 && fpRate < 5 && highFalsePositives.length === 0 && recallOk;
console.log(`\n发布门（T8.6）：${gatePassed ? '✅ 达标' : '❌ 不达标'}`);

/** 从 git 历史取最近的 hunk（每段当作一次「编辑」）。 */
function recentHunks(limit = 40) {
  const out = execFileSync('git', ['log', '-p', '--no-color', '-n', '12', '--unified=2'], {
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
  });
  const hunks = [];
  let current = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      if (current.length > 0) hunks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      // 只保留 hunk 内的行（遇到下一个 diff 文件头就重置）
      if (line.startsWith('diff --git')) {
        hunks.push(current.join('\n'));
        current = [];
      } else {
        current.push(line);
      }
    }
    if (hunks.length >= limit) break;
  }
  if (current.length > 0 && hunks.length < limit) hunks.push(current.join('\n'));
  return hunks.slice(0, limit);
}

const hunks = recentHunks(40);
console.log(`\n=== ② git 历史分布（补充观察，${hunks.length} 段真实 hunk；不计入发布门）===\n`);

let withHits = 0;
const perRule = new Map();
for (const [index, hunk] of hunks.entries()) {
  const hits = analyzeDiff(hunk, RISK_RULES);
  if (hits.length > 0) {
    withHits += 1;
    for (const hit of hits) {
      perRule.set(hit.ruleId, (perRule.get(hit.ruleId) ?? 0) + 1);
    }
    console.log(`— hunk #${index + 1}（${hits.length} 条命中）`);
    for (const hit of hits) {
      console.log(`  [${hit.level}] ${hit.ruleId}: ${hit.line.trim().slice(0, 100)}`);
    }
  }
}

console.log(`\n有命中的 hunk：${withHits}/${hunks.length}`);
console.log('各规则命中分布：');
for (const [ruleId, count] of [...perRule.entries()].sort((a, b) => b[1] - a[1])) {
  const rule = RISK_RULES.find((r) => r.id === ruleId);
  console.log(`  ${ruleId.padEnd(24)} ${String(count).padStart(3)} 次  [${rule?.level ?? '?'}]`);
}
console.log(
  '\n请人工核对以上命中：真实风险应占绝大多数；若某规则大量误报，应加 negativePatterns 收窄（不许整条删）。',
);

if (!gatePassed) {
  process.exitCode = 1;
}
