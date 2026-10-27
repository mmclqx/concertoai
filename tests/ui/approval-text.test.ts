/**
 * 审批卡纯字符串渲染测试（v5.0 T9.3b）。
 *
 * 本文件覆盖「文案层」全部逻辑，**不需要 ink-testing-library**——这正是分层架构的收益：
 * 文案分支再复杂也能用纯函数测。
 *
 * 三条红线（T8 已知局限的落地）各有一组用例：
 * ① medium 规则绝不出现「危险」措辞；
 * ② impact 未分析（timeout/skipped/error）绝不说「无影响 / 0 个引用」；
 * ③ 默认 diff ≤ 12 行折叠 + `[v]` 展开截断 500 行。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ApprovalInsight } from '../../src/core/approval-insight';
import { emptyImpact, parseDiff } from '../../src/core/approval-insight';
import type { ImpactSummary } from '../../src/core/impact-scan';
import type { RiskHit, RiskLevel } from '../../src/core/risk-rules';
import { RISK_RULES } from '../../src/core/risk-rules';
import { setLocale } from '../../src/i18n';
import {
  analyzableDetail,
  COLLAPSED_DIFF_LINES,
  describeImpact,
  fileLineNumbers,
  isPlainApproval,
  MAX_FULL_DIFF_LINES,
  renderApprovalLines,
  renderApprovalText,
} from '../../src/ui/approval-text';

/** 构造一条命中。 */
function hit(overrides: Partial<RiskHit> = {}): RiskHit {
  return {
    ruleId: 'network-timeout',
    category: '网络请求/超时',
    level: 'medium',
    side: 'added',
    line: '+setTimeout(() => ctrl.abort(), 10000);',
    diffLineIndex: 2,
    why: '超时/重试参数变化会改变失败时的行为（过久卡住、过短误判）',
    suggestion: '确认超时值变化方向与失败重试次数是否与预期一致',
    ...overrides,
  };
}

/** 构造一份洞察。 */
function insight(overrides: Partial<ApprovalInsight> = {}): ApprovalInsight {
  const hits = overrides.hits ?? [hit()];
  const level: RiskLevel =
    overrides.level ??
    (hits.some((h) => h.level === 'high') ? 'high' : hits.length > 0 ? 'medium' : 'low');
  return {
    level,
    changeNatures: hits.length > 0 ? ['改动网络请求或超时'] : [],
    hits,
    focusLines: overrides.focusLines ?? (hits.length > 0 ? [hits[0]?.diffLineIndex ?? 0] : []),
    impact: overrides.impact ?? {
      ...emptyImpact('ok'),
      referenceCount: 4,
      topPaths: ['src/auth/a.ts', 'src/pay/b.ts'],
      scannedCount: 88,
    },
    degraded: false,
    elapsedMs: 3,
    ...overrides,
  };
}

/** 20 行 diff（前 3 行改动，其余上下文），用于折叠测试。 */
function diffOfLines(count: number): string {
  return [
    '@@ -1,3 +1,4 @@',
    '+first',
    '-second',
    '+third',
    ...Array.from({ length: count - 3 }, (_, i) => ` context ${i}`),
  ].join('\n');
}

const BASE = {
  kind: 'edit' as const,
  summary: '编辑文件 src/api/fetch.ts',
  detail: diffOfLines(20),
};

describe('plain 路径（无洞察 / 降级）', () => {
  it('insight 缺失 → 走 plain，逐字节等价 v4.1.1 三行', () => {
    const lines = renderApprovalLines({ ...BASE, insight: null });
    expect(lines.map((l) => l.role)).toEqual(['title', 'detail', 'buttons']);
    expect(lines[0]?.text).toBe('编辑文件: 编辑文件 src/api/fetch.ts');
    expect(lines[2]?.text).toBe('批准 (y / Enter) / 拒绝 (n / Esc)');
  });

  it('degradeReason=config-off / error / non-tty / ci 全部走 plain', () => {
    for (const reason of ['config-off', 'error', 'non-tty', 'ci'] as const) {
      expect(
        isPlainApproval({ ...BASE, insight: insight({ degraded: true, degradeReason: reason }) }),
      ).toBe(true);
    }
  });

  it('rich=false 强制 plain（即使有完整洞察）', () => {
    expect(isPlainApproval({ ...BASE, insight: insight(), rich: false })).toBe(true);
  });

  it('huge-diff 不整卡降级（保留标题+行数提示），但明确说分析已跳过', () => {
    const text = renderApprovalText({
      ...BASE,
      insight: insight({
        degraded: true,
        degradeReason: 'huge-diff',
        hits: [],
        changeNatures: [],
        focusLines: [],
      }),
    });
    expect(isPlainApproval({ ...BASE, insight: insight({ degradeReason: 'huge-diff' }) })).toBe(
      false,
    );
    expect(text).toContain('风险分析已跳过（超大 diff）');
  });
});

describe('rich 路径七区块', () => {
  it('渲染标题 / 改动性质 / 影响面 / 风险点 / 关注行 / diff / 按键', () => {
    const text = renderApprovalText({ ...BASE, insight: insight() });
    expect(text).toContain('中风险审批');
    expect(text).toContain('改动性质：改动网络请求或超时');
    expect(text).toContain('影响面：');
    expect(text).toContain('💡 建议重点关注');
    expect(text).toContain('@@ -1,3 +1,4 @@');
    expect(text).toContain('[y] 批准');
    expect(text).toContain('[n] 拒绝（AI 将尝试更保守的方案）');
  });

  it('high / medium / low 三档标题与图标正确（low 不标红用 ✅）', () => {
    const high = renderApprovalText({
      ...BASE,
      insight: insight({ hits: [hit({ level: 'high' })], level: 'high' }),
    });
    expect(high).toContain('⚠️ 高风险审批');
    const medium = renderApprovalText({ ...BASE, insight: insight() });
    expect(medium).toContain('🟡 中风险审批');
    const low = renderApprovalText({
      ...BASE,
      insight: insight({ hits: [], level: 'low', changeNatures: [], focusLines: [] }),
    });
    expect(low).toContain('✅ 低风险审批');
    expect(low).not.toContain('⚠️ 高风险审批');
  });

  it('无命中 → 显示「未检测到已知风险模式（已检查 N 类规则）」', () => {
    const text = renderApprovalText({
      ...BASE,
      insight: insight({ hits: [], level: 'low', changeNatures: [], focusLines: [] }),
    });
    expect(text).toContain(`未检测到已知风险模式（已检查 ${RISK_RULES.length} 类规则）`);
  });

  it('ruleCount 显式传入时按传入值显示（config 停用规则后不说假话）', () => {
    const text = renderApprovalText({
      ...BASE,
      insight: insight({ hits: [], level: 'low', changeNatures: [], focusLines: [] }),
      ruleCount: 9,
    });
    expect(text).toContain('已检查 9 类规则');
  });

  it('编辑意图单独一行（新建 vs 局部修改）', () => {
    expect(renderApprovalText({ ...BASE, insight: insight(), intent: 'create' })).toContain(
      '操作意图：新建文件',
    );
    expect(renderApprovalText({ ...BASE, insight: insight(), intent: 'modify' })).toContain(
      '操作意图：局部修改',
    );
  });

  it('风险点最多 3 条（一次说 8 条 = 没有重点）', () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit({ diffLineIndex: i + 1 }));
    const lines = renderApprovalLines({ ...BASE, insight: insight({ hits }) });
    const riskLines = lines.filter((l) => l.role === 'attention');
    // 1 行标题 + ≤3 条明细
    expect(riskLines.length).toBeLessThanOrEqual(4);
  });
});

// ═══════════════════════════════════════════════════════════
// 红线 ①：medium / 易误报规则绝不出现「危险」措辞
// ═══════════════════════════════════════════════════════════

describe('红线① 措辞：medium 绝不出现「危险」', () => {
  it('test-assertion-change（已知噪声源）全文无「危险」二字', () => {
    const text = renderApprovalText({
      ...BASE,
      insight: insight({
        hits: [
          hit({
            ruleId: 'test-assertion-change',
            category: '测试断言弱化',
            why: '删除断言等于降低测试保护力度，回归可能悄悄发生',
            suggestion: '确认断言是被移到别处，还是为了让测试通过而被删',
          }),
        ],
        changeNatures: ['改动测试断言'],
      }),
      intent: 'modify',
      showHelp: true,
    });
    expect(text).not.toContain('危险');
    expect(text).not.toContain('危 险');
  });

  it('全部 medium 规则 + 说明展开时也不出现「危险」', () => {
    for (const rule of RISK_RULES) {
      const text = renderApprovalText({
        ...BASE,
        insight: insight({
          hits: [
            hit({
              ruleId: rule.id,
              category: rule.category,
              level: rule.level,
              why: rule.why,
              suggestion: rule.suggestion,
            }),
          ],
        }),
        showHelp: true,
      });
      expect(text, `规则 ${rule.id} 的文案出现了「危险」`).not.toContain('危险');
    }
  });

  it('medium 用「建议重点关注（中风险提示，非阻断）」而非风险定论', () => {
    const text = renderApprovalText({ ...BASE, insight: insight() });
    expect(text).toContain('建议重点关注（中风险提示，非阻断）');
    // medium 不该用 high 的「风险点：」小节标题
    expect(text).not.toContain('风险点：');
  });

  it('medium 的说明解释「这不是结论」（避免用户把提示当判决）', () => {
    const text = renderApprovalText({ ...BASE, insight: insight(), showHelp: true });
    // 说明是散文，会按宽度折行（不截断）→ 断言前去掉换行，校验的是「整句没被砍掉」
    expect(text.replace(/\n/g, '')).toContain('只是「建议重点关注」，不是结论。');
    // 折行不得留下省略号（截断的痕迹）——这正是本次修掉的实现缺陷
    const helpSection = text.slice(text.indexOf('这一屏在说什么'));
    expect(helpSection).not.toContain('…');
  });
});

// ═══════════════════════════════════════════════════════════
// 红线 ②：影响面未分析 ≠ 无影响
// ═══════════════════════════════════════════════════════════

describe('红线② 影响面：未分析绝不说「无影响 / 0 个引用」', () => {
  const forbidden = ['无影响', '0 个引用', '0个引用'];

  it('timeout → 「影响面未分析（超时 300ms）」', () => {
    const impact: ImpactSummary = { ...emptyImpact('timeout'), elapsedMs: 300 };
    const text = renderApprovalText({ ...BASE, insight: insight({ impact }) });
    expect(text).toContain('影响面未分析（超时 300ms）');
    for (const word of forbidden) {
      expect(text).not.toContain(word);
    }
  });

  it('skipped（项目过大）→ 「影响面未分析（项目过大…）」', () => {
    const impact: ImpactSummary = { ...emptyImpact('skipped'), scannedCount: 0 };
    const text = renderApprovalText({ ...BASE, insight: insight({ impact }) });
    expect(text).toContain('影响面未分析（项目过大');
    for (const word of forbidden) {
      expect(text).not.toContain(word);
    }
  });

  it('error → 「影响面未分析（读取失败）」', () => {
    const text = renderApprovalText({
      ...BASE,
      insight: insight({ impact: emptyImpact('error') }),
    });
    expect(text).toContain('影响面未分析（读取失败）');
    for (const word of forbidden) {
      expect(text).not.toContain(word);
    }
  });

  it('ok 且 0 引用 → 如实说「未发现其他文件引用该文件（已扫描 N 个文件）」', () => {
    const impact: ImpactSummary = { ...emptyImpact('ok'), referenceCount: 0, scannedCount: 42 };
    const text = renderApprovalText({ ...BASE, insight: insight({ impact }) });
    expect(text).toContain('未发现其他文件引用该文件（已扫描 42 个文件）');
    // 这是「确实扫过且确实没有」，与「未分析」是两种事实，措辞必须区分开
    expect(text).not.toContain('影响面未分析');
  });

  it('ok 且有引用 → 数量 + 前 3 路径（basename 缩写）', () => {
    const impact: ImpactSummary = {
      ...emptyImpact('ok'),
      referenceCount: 4,
      topPaths: ['src/auth/login.ts', 'src/pay/charge.ts', 'src/user/profile.ts'],
      scannedCount: 120,
    };
    const text = renderApprovalText({ ...BASE, insight: insight({ impact }) });
    expect(text).toContain('该文件被 4 个文件引用');
    expect(text).toContain('login.ts');
    expect(text).toContain('charge.ts');
  });

  it('部分文件读取失败 → 追加「N 个文件读取失败已跳过」（不掩盖盲区）', () => {
    const impact: ImpactSummary = {
      ...emptyImpact('ok'),
      referenceCount: 2,
      scannedCount: 50,
      skippedCount: 3,
    };
    const text = renderApprovalText({ ...BASE, insight: insight({ impact }) });
    expect(text).toContain('3 个文件读取失败已跳过');
  });

  it('shell / model（impactApplies=false）→ 「不适用」，不冒充「项目过大」', () => {
    const text = renderApprovalText({
      kind: 'shell',
      summary: '执行命令: npm test',
      detail: 'npm test',
      insight: insight({
        hits: [],
        level: 'low',
        changeNatures: [],
        focusLines: [],
        impact: emptyImpact('skipped'),
      }),
      impactApplies: false,
    });
    expect(text).toContain('不适用（该操作不涉及文件引用）');
    expect(text).not.toContain('项目过大');
  });

  it('describeImpact 四态文案两两不同（不存在「撞车」导致的事实混淆）', () => {
    const texts = (['ok', 'timeout', 'skipped', 'error'] as const).map((status) =>
      describeImpact({ ...emptyImpact(status), scannedCount: 10 }),
    );
    expect(new Set(texts).size).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════
// 红线 ③：默认折叠 ≤ 12 行 + [v] 展开截断 500 行
// ═══════════════════════════════════════════════════════════

describe('红线③ 性能：diff 默认折叠', () => {
  it('20 行 diff 默认只渲染 ≤ 12 行 + 折叠提示（带剩余行数）', () => {
    const detail = diffOfLines(20);
    const total = parseDiff(detail).length; // 1 hunk 头 + 20 行 = 21
    const lines = renderApprovalLines({
      ...BASE,
      detail,
      insight: insight({ hits: [hit({ diffLineIndex: 2 })], focusLines: [2] }),
    });
    const diffLines = lines.filter((l) =>
      ['diff-add', 'diff-del', 'diff-hunk', 'diff-context'].includes(l.role),
    );
    expect(diffLines.length).toBeLessThanOrEqual(COLLAPSED_DIFF_LINES);
    const fold = lines.find((l) => l.role === 'fold');
    expect(fold?.text).toContain(`还有 ${total - diffLines.length} 行未显示`);
    expect(fold?.text).toContain('按 v 查看完整 diff');
  });

  it('默认视图「只显示含 ⚠️ 的 hunk + 上下文 2 行」（T9.2 规格，不铺满 12 行）', () => {
    const detail = diffOfLines(60);
    const lines = renderApprovalLines({
      ...BASE,
      detail,
      insight: insight({ hits: [hit({ diffLineIndex: 40 })], focusLines: [40] }),
    });
    const diffLines = lines.filter((l) =>
      ['diff-add', 'diff-del', 'diff-hunk', 'diff-context'].includes(l.role),
    );
    // 1 个重点行 + 上下各 2 行 = 5 行（远小于 12 行上限）
    expect(diffLines.length).toBe(5);
  });

  it('≤ 12 行 diff 全量渲染且无折叠提示', () => {
    const detail = diffOfLines(10);
    const lines = renderApprovalLines({ ...BASE, detail, insight: insight({ focusLines: [] }) });
    expect(lines.some((l) => l.role === 'fold')).toBe(false);
  });

  it('折叠时 ⚠️ 行必留（否则「重点看这里」指向看不见的代码）', () => {
    const detail = diffOfLines(60);
    const lines = renderApprovalLines({ ...BASE, detail, insight: insight({ focusLines: [40] }) });
    expect(lines.some((l) => l.text.endsWith('⚠️'))).toBe(true);
    expect(lines.some((l) => l.text.includes('context 37'))).toBe(true); // 上下文 2 行
  });

  it('[v] 展开 → 全量渲染（> 12 行）且按键提示变为「收起」', () => {
    const detail = diffOfLines(20);
    const total = parseDiff(detail).length;
    const lines = renderApprovalLines({ ...BASE, detail, insight: insight(), fullDiff: true });
    const diffLines = lines.filter((l) =>
      ['diff-add', 'diff-del', 'diff-hunk', 'diff-context'].includes(l.role),
    );
    expect(diffLines.length).toBe(total);
    expect(diffLines.length).toBeGreaterThan(COLLAPSED_DIFF_LINES);
    expect(lines.at(-1)?.text).toContain('[v] 收起 diff');
  });

  it('[v] 展开超 500 行 → 截断并提示（与 T8 huge-diff 阈值同量级）', () => {
    const detail = diffOfLines(800);
    const lines = renderApprovalLines({
      ...BASE,
      detail,
      insight: insight({ focusLines: [] }),
      fullDiff: true,
    });
    const diffLines = lines.filter((l) =>
      ['diff-add', 'diff-del', 'diff-hunk', 'diff-context'].includes(l.role),
    );
    expect(diffLines.length).toBe(MAX_FULL_DIFF_LINES);
    expect(lines.some((l) => l.role === 'fold' && l.text.includes('diff 已截断'))).toBe(true);
  });

  it('输出行数有硬上界（折叠态 ≤ 40 行，防 Ink 重渲染卡顿）', () => {
    const detail = diffOfLines(300);
    const lines = renderApprovalLines({ ...BASE, detail, insight: insight({ focusLines: [100] }) });
    expect(lines.length).toBeLessThanOrEqual(40);
  });
});

describe('diff 行标注与行号', () => {
  it('focusLines 对应的 diff 行尾打 ⚠️，其他行不打', () => {
    // BASE 的 diff：0=hunk 头, 1=+first, 2=-second, 3=+third, 4.. = 上下文
    const lines = renderApprovalLines({
      ...BASE,
      insight: insight({ hits: [hit({ diffLineIndex: 2 })], focusLines: [2] }),
    });
    const marked = lines.filter((l) => l.text.endsWith('⚠️'));
    expect(marked.length).toBe(1);
    expect(marked[0]?.text).toContain('-second');
  });

  it('CRLF diff 与 LF diff 的标注结果一致（W2）', () => {
    const lf = diffOfLines(6);
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = renderApprovalLines({ ...BASE, detail: lf, insight: insight({ focusLines: [2] }) });
    const b = renderApprovalLines({ ...BASE, detail: crlf, insight: insight({ focusLines: [2] }) });
    expect(b.map((l) => l.text)).toEqual(a.map((l) => l.text));
  });

  it('fileLineNumbers：标准 hunk 头按统一 diff 语义推算文件行号', () => {
    // 统一 diff 语义（`@@ -10,3 +10,4 @@`）：旧文件 3 行占 10/11/12，新文件 4 行占 10/11/12/13
    //   ctx  → 旧 10 / 新 10
    //   -old → 旧 11
    //   +new1→ 新 11
    //   +new2→ 新 12
    //   ctx2 → 旧 12 / 新 13
    const detail = ['@@ -10,3 +10,4 @@', ' ctx', '-old', '+new1', '+new2', ' ctx2'].join('\n');
    const map = fileLineNumbers(parseDiff(detail));
    expect(map.get(0)).toBeUndefined(); // hunk 头不映射
    expect(map.get(1)).toBe(10); // 上下文行（新文件侧）
    expect(map.get(2)).toBe(11); // 删除行取**旧**文件行号
    expect(map.get(3)).toBe(11); // 新增行取**新**文件行号
    expect(map.get(4)).toBe(12);
    expect(map.get(5)).toBe(13); // 后续上下文行：新文件侧已推进到 13
  });

  it('新建文件形态（@@ +1,N @@，无 - 段）也能推算', () => {
    const detail = ['@@ +1,3 @@', '+a', '+b', '+c'].join('\n');
    const map = fileLineNumbers(parseDiff(detail));
    expect(map.get(1)).toBe(1);
    expect(map.get(2)).toBe(2);
    expect(map.get(3)).toBe(3);
  });

  it('「💡 建议重点关注」显示的是**文件行号**而非 diff 下标（否则用户找不到那一行）', () => {
    const detail = ['@@ -40,3 +40,4 @@', ' ctx', '-old', '+setTimeout(f, 10000);', ' ctx2'].join(
      '\n',
    );
    // 数据必须自洽：focusLines 由 hits 派生，命中的 diffLineIndex 就是重点行
    const text = renderApprovalText({
      ...BASE,
      detail,
      insight: insight({ hits: [hit({ diffLineIndex: 3 })], focusLines: [3] }),
    });
    // diff 下标 3（新文件侧第 2 行）→ 文件第 41 行
    expect(text).toContain('💡 建议重点关注：第 41 行');
  });

  it('focusLines 与 hits 下标不一致时，重点行不静默消失（回退最近命中）', () => {
    const detail = ['@@ -40,3 +40,4 @@', ' ctx', '-old', '+setTimeout(f, 10000);', ' ctx2'].join(
      '\n',
    );
    const text = renderApprovalText({
      ...BASE,
      detail,
      insight: insight({ hits: [hit({ diffLineIndex: 2 })], focusLines: [3] }),
    });
    expect(text).toContain('💡 建议重点关注：第 41 行');
    expect(text).toContain('确认超时值变化方向'); // 建议文案来自最近命中，不是空白
  });
});

describe('宽度截断（中文/emoji 不溢出）', () => {
  it('超长中文行按显示宽度截断，宽度不超上限', () => {
    const detail = `@@ -1,1 +1,1 @@\n+${'超时配置'.repeat(40)}`;
    const lines = renderApprovalLines({
      ...BASE,
      detail,
      insight: insight({ focusLines: [1] }),
      width: 40,
    });
    for (const line of lines) {
      // 按键行不截断（安全按键必须完整）
      if (line.role !== 'buttons') {
        expect(line.text.length).toBeGreaterThan(0);
        expect(line.text.length).toBeLessThanOrEqual(60); // 宽度 ≤ 40 格，字符数上界宽于格数
      }
    }
  });

  it('宽度下限保护（极窄终端也不崩）', () => {
    expect(() => renderApprovalLines({ ...BASE, insight: insight(), width: 1 })).not.toThrow();
  });
});

describe('analyzableDetail：shell 命令文本适配', () => {
  it('edit 原样返回（已是统一 diff）', () => {
    expect(analyzableDetail('edit', '+a\n-b')).toBe('+a\n-b');
  });

  it('shell 逐行补 + 前缀（否则规则一条都命中不了）', () => {
    expect(analyzableDetail('shell', 'rm -rf /tmp/x')).toBe('+rm -rf /tmp/x');
  });
});

describe('架构护栏（T9.3b 铁律）', () => {
  const sourceOf = (relative: string): string =>
    readFileSync(path.join(process.cwd(), relative), 'utf8');

  it('approval-text.ts 零 ink / react import', () => {
    const source = sourceOf('src/ui/approval-text.ts');
    expect(source).not.toMatch(/from\s+['"]ink['"]/);
    expect(source).not.toMatch(/from\s+['"]react['"]/);
    expect(source).not.toMatch(/require\(\s*['"](ink|react)['"]\s*\)/);
  });

  it('modals.tsx 无面向用户的文案字面量（全部来自 i18n + renderApprovalLines）', () => {
    const source = sourceOf('src/ui/modals.tsx');
    // 只审「审批卡」段（计划进度区是 v3.x 既有代码，其文案本就在 i18n 之外，不在本任务范围）
    const approvalSection = source.slice(0, source.indexOf('/** 计划展示最大字符数'));
    // 逐个**字符串字面量**检查（先剔注释，否则注释里的中文说明会被误判——
    // 逐行剥离注释后，剩下的字符串字面量才是真正会渲染到屏幕的文字）
    const withoutComments = approvalSection
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    const literals = [...withoutComments.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map(
      (m) => m[1] ?? m[2] ?? m[3] ?? '',
    );
    const cjk = literals.filter((text) => /[\u4e00-\u9fff]/.test(text));
    expect(cjk).toEqual([]);
  });

  it('toggle-throttle.ts 零 react/ink 依赖（纯逻辑可测）', () => {
    const source = sourceOf('src/ui/toggle-throttle.ts');
    expect(source).not.toMatch(/from\s+['"](ink|react)['"]/);
  });
});

describe('文案一致性（plain 与 rich 共用同一渲染函数）', () => {
  it('renderApprovalText 与 renderApprovalLines 输出逐行等价', () => {
    const options = { ...BASE, insight: insight(), showHelp: true, fullDiff: false };
    const lines = renderApprovalLines(options);
    expect(renderApprovalText(options).split('\n')).toEqual(lines.map((l) => l.text));
  });

  it('英文环境下也有完整 rich 文案（G4 双份，英文渲染无残留中文）', () => {
    setLocale('en');
    try {
      // 用英文数据（summary / why / suggestion 由工具与规则表提供，测试里显式给英文），
      // 这样「无中文残留」的断言才只反映**渲染层文案**是否正确本地化
      const text = renderApprovalText({
        kind: 'edit',
        summary: 'edit src/api/fetch.ts',
        detail: '@@ -1,3 +1,4 @@\n+first\n-second\n+third\n ctx',
        insight: {
          level: 'medium',
          changeNatures: ['network timeout changed'],
          hits: [
            {
              ruleId: 'network-timeout',
              category: 'network',
              level: 'medium',
              side: 'added',
              line: '+setTimeout(() => ctrl.abort(), 10000);',
              diffLineIndex: 2,
              why: 'timeout change alters failure behaviour',
              suggestion: 'check the timeout direction',
            },
          ],
          focusLines: [2],
          impact: {
            ...emptyImpact('ok'),
            referenceCount: 2,
            topPaths: ['src/a/auth.ts'],
            scannedCount: 10,
          },
          degraded: false,
          elapsedMs: 3,
        },
        showHelp: true,
      });
      expect(text).toContain('Medium-risk approval');
      expect(text).toContain('[n] reject (AI will try a more conservative approach)');
      expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    } finally {
      setLocale('zh');
    }
  });
});
