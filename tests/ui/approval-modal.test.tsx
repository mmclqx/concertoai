/**
 * 审批框 Ink 渲染测试（v5.0 T9.2）。
 *
 * 分工：**文案分支全部在 `approval-text.test.ts` 用纯函数覆盖**（不需要 Ink）；
 * 本文件只验「Ink 把字符串正确摆上去」——七区块可见、三档着色、`[v]`/`[?]` 切换、
 * 以及 7 个场景端到端不崩（对应验收：high / medium / low / 无命中 / 超时 / 跳过 / 空洞察）。
 */

import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApprovalInsight } from '../../src/core/approval-insight';
import { emptyImpact } from '../../src/core/approval-insight';
import type { RiskHit } from '../../src/core/risk-rules';
import { RISK_RULES } from '../../src/core/risk-rules';
import { setLocale } from '../../src/i18n';
import { ApprovalModal, EditConfirm, ShellConfirm } from '../../src/ui/modals';

beforeEach(() => {
  setLocale('zh');
});

/** 一条命中。 */
function hit(overrides: Partial<RiskHit> = {}): RiskHit {
  return {
    ruleId: 'network-timeout',
    category: '网络请求/超时',
    level: 'medium',
    side: 'added',
    line: '+  setTimeout(() => ctrl.abort(), 10000);',
    diffLineIndex: 3,
    why: '超时/重试参数变化会改变失败时的行为（过久卡住、过短误判）',
    suggestion: '确认超时值变化方向与失败重试次数是否与预期一致',
    ...overrides,
  };
}

/** 一份洞察。 */
function insight(overrides: Partial<ApprovalInsight> = {}): ApprovalInsight {
  const hits = overrides.hits ?? [hit()];
  return {
    level: hits.some((h) => h.level === 'high') ? 'high' : hits.length > 0 ? 'medium' : 'low',
    changeNatures: hits.length > 0 ? [hits[0]?.category ?? '改动'] : [],
    hits,
    focusLines: hits.length > 0 ? [hits[0]?.diffLineIndex ?? 0] : [],
    impact: {
      ...emptyImpact('ok'),
      referenceCount: 4,
      topPaths: ['src/auth/login.ts', 'src/pay/p.ts'],
      scannedCount: 100,
    },
    degraded: false,
    elapsedMs: 6,
    ...overrides,
  };
}

const DETAIL = [
  '@@ -40,4 +40,5 @@',
  ' const ctrl = new AbortController();',
  '-  setTimeout(() => ctrl.abort(), 5000);',
  '+  setTimeout(() => ctrl.abort(), 10000);',
  ' });',
].join('\n');

/** 渲染并返回首帧文本。 */
function frame(element: React.ReactElement): string {
  const { lastFrame, unmount } = render(element);
  const text = lastFrame() ?? '';
  unmount();
  return text;
}

describe('ApprovalModal 七区块（rich）', () => {
  it('high：标题/改动性质/影响面/风险点/关注行/diff/按键全部可见', () => {
    const text = frame(
      <ApprovalModal
        kind="edit"
        summary="编辑 src/api/fetch.ts"
        detail={DETAIL}
        intent="modify"
        insight={insight({
          hits: [hit({ level: 'high', why: '新增了删除文件/目录的操作，误删后无法恢复' })],
        })}
        ruleCount={RISK_RULES.length}
      />,
    );
    expect(text).toContain('⚠️ 高风险审批');
    expect(text).toContain('操作意图');
    expect(text).toContain('改动性质');
    expect(text).toContain('影响面');
    expect(text).toContain('风险点');
    expect(text).toContain('建议重点关注');
    expect(text).toContain('+  setTimeout(() => ctrl.abort(), 10000);');
    expect(text).toContain('[y] 批准');
    expect(text).toContain('[n] 拒绝（AI 将尝试更保守的方案）');
  });

  it('medium：标题为「中风险审批」，全文无「危险」', () => {
    const text = frame(
      <ApprovalModal kind="edit" summary="编辑 t.test.ts" detail={DETAIL} insight={insight()} />,
    );
    expect(text).toContain('🟡 中风险审批');
    expect(text).not.toContain('危险');
    expect(text).toContain('建议重点关注（中风险提示，非阻断）');
  });

  it('low：绿色 ✅ 低风险 + 「未检测到已知风险模式」，不出现高风险字样', () => {
    const text = frame(
      <ApprovalModal
        kind="edit"
        summary="编辑 src/a.ts"
        detail={DETAIL}
        insight={insight({ hits: [], level: 'low', changeNatures: [], focusLines: [] })}
      />,
    );
    expect(text).toContain('✅ 低风险审批');
    expect(text).toContain('未检测到已知风险模式');
    expect(text).not.toContain('⚠️ 高风险');
  });

  it('影响面超时：显示「影响面未分析（超时 300ms）」，不显示 0 引用', () => {
    const text = frame(
      <ApprovalModal
        kind="edit"
        summary="编辑 src/a.ts"
        detail={DETAIL}
        insight={insight({ impact: { ...emptyImpact('timeout'), elapsedMs: 300 } })}
      />,
    );
    expect(text).toContain('影响面未分析（超时 300ms）');
    expect(text).not.toContain('0 个引用');
    expect(text).not.toContain('无影响');
  });

  it('影响面跳过（项目过大）：如实说明，不冒充「无影响」', () => {
    const text = frame(
      <ApprovalModal
        kind="edit"
        summary="编辑 src/a.ts"
        detail={DETAIL}
        insight={insight({ impact: emptyImpact('skipped') })}
      />,
    );
    expect(text).toContain('项目过大');
    expect(text).not.toContain('无影响');
  });

  it('空洞察（分析失败/shell）：自动 plain，仍可审批（G2）', () => {
    const text = frame(
      <ApprovalModal kind="edit" summary="编辑 src/a.ts" detail={DETAIL} insight={null} />,
    );
    // plain = 「标题: 摘要」原文（v4.1.1 形态）
    expect(text).toContain('编辑文件: 编辑 src/a.ts');
    expect(text).toContain('批准 (y / Enter) / 拒绝 (n / Esc)');
    // plain 不出现 rich 区块
    expect(text).not.toContain('影响面');
    expect(text).not.toContain('建议重点关注');
  });

  it('降级原因 error 等同空洞察（plain）', () => {
    const text = frame(
      <ApprovalModal
        kind="edit"
        summary="编辑 src/a.ts"
        detail={DETAIL}
        insight={insight({ degraded: true, degradeReason: 'error' })}
      />,
    );
    expect(text).toContain('批准 (y / Enter)');
    expect(text).not.toContain('中风险审批');
  });

  it('shell 命令：显示命令文本，影响面显示「不适用」', () => {
    const text = frame(
      <ApprovalModal
        kind="shell"
        summary="执行命令: rm -rf build"
        detail={'rm -rf build'}
        impactApplies={false}
        insight={insight({
          hits: [
            hit({
              ruleId: 'dangerous-delete',
              level: 'high',
              why: '新增了删除文件/目录的操作，误删后无法恢复',
            }),
          ],
          impact: emptyImpact('skipped'),
        })}
      />,
    );
    expect(text).toContain('rm -rf build');
    expect(text).toContain('不适用');
    expect(text).not.toContain('项目过大');
  });
});

describe('ApprovalModal 展示态切换', () => {
  it('[v] 展开后 diff 行数明显增加，按键变为「收起 diff」', () => {
    const long = [
      '@@ -1,30 +1,30 @@',
      ...Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`),
    ].join('\n');
    const collapsed = frame(
      <ApprovalModal kind="edit" summary="编辑 a.ts" detail={long} insight={insight()} />,
    );
    const expanded = frame(
      <ApprovalModal kind="edit" summary="编辑 a.ts" detail={long} insight={insight()} fullDiff />,
    );
    expect(expanded.split('\n').length).toBeGreaterThan(collapsed.split('\n').length);
    expect(collapsed).toContain('[v] 完整 diff');
    expect(expanded).toContain('[v] 收起 diff');
  });

  it('[?] 展开内联说明（含关闭方式，不跳外链）', () => {
    const text = frame(
      <ApprovalModal
        kind="edit"
        summary="编辑 a.ts"
        detail={DETAIL}
        insight={insight()}
        showHelp
      />,
    );
    expect(text).toContain('这一屏在说什么');
    expect(text).toContain('approvalInsight');
    expect(text).toContain('[?] 收起说明');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('focusLines 行尾打 ⚠️（Ink 渲染也不丢标记）', () => {
    const text = frame(
      <ApprovalModal kind="edit" summary="编辑 a.ts" detail={DETAIL} insight={insight()} />,
    );
    expect(text).toContain('⚠️');
  });
});

describe('兼容旧调用（EditConfirm / ShellConfirm）', () => {
  it('EditConfirm 不带 insight 时渲染 v4.1.1 三行', () => {
    const text = frame(
      <EditConfirm summary="编辑文件 a.txt" detail={'@@ -1,1 +1,1 @@\n-old\n+new'} />,
    );
    expect(text).toContain('编辑文件');
    expect(text).toContain('-old');
    expect(text).toContain('+new');
    expect(text).toContain('批准');
  });

  it('ShellConfirm 显示命令与按键提示', () => {
    const text = frame(<ShellConfirm summary="执行命令: npm test" detail="npm test" />);
    expect(text).toContain('执行命令');
    expect(text).toContain('npm test');
    expect(text).toContain('拒绝');
  });
});
