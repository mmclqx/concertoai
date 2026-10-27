/**
 * 风险规则表结构测试（v5.0 T8.2 / T8.3 的平台无关红线）。
 *
 * 从 `approval-insight.test.ts` 迁出（任务书文件清单要求独立文件，2026-10-27 用户确认）。
 *
 * 这里只验**规则表的静态性质**（结构 / 唯一性 / 正则安全性 / 启停）；
 * 「规则能否真的命中」「是否误报」在 `approval-insight.test.ts` 与 fixtures 回归里验。
 */

import { describe, expect, it } from 'vitest';

import { analyzeDiff } from '../../src/core/approval-insight';
import { activeRiskRules, RISK_RULES } from '../../src/core/risk-rules';

describe('规则表结构（T8 验收：≥14 条且字段齐备）', () => {
  it('至少 14 条规则', () => {
    expect(RISK_RULES.length).toBeGreaterThanOrEqual(14);
  });

  it('每条规则字段齐备且非空', () => {
    for (const rule of RISK_RULES) {
      expect(rule.id, 'ruleId').toBeTruthy();
      expect(rule.category, `${rule.id} category`).toBeTruthy();
      expect(['high', 'medium', 'low']).toContain(rule.level);
      expect(['added', 'removed', 'both']).toContain(rule.target);
      expect(rule.patterns.length, `${rule.id} patterns`).toBeGreaterThan(0);
      expect(rule.why, `${rule.id} why`).toBeTruthy();
      expect(rule.suggestion, `${rule.id} suggestion`).toBeTruthy();
    }
  });

  it('规则 id 唯一', () => {
    const ids = RISK_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('规则正则全部为字面量（禁止动态构造 / g flag 残留 lastIndex）', () => {
    for (const rule of RISK_RULES) {
      for (const pattern of [...rule.patterns, ...(rule.negativePatterns ?? [])]) {
        // g flag 会让 test() 带 lastIndex 状态，跨行调用结果不稳定
        expect(pattern.global, `${rule.id} 不得使用 g flag`).toBe(false);
      }
    }
  });

  it('activeRiskRules 按 disabled 过滤；未知 id 静默忽略', () => {
    expect(activeRiskRules()).toHaveLength(RISK_RULES.length);
    expect(activeRiskRules([])).toHaveLength(RISK_RULES.length);
    const filtered = activeRiskRules(['dangerous-delete', 'no-such-rule']);
    expect(filtered).toHaveLength(RISK_RULES.length - 1);
    expect(filtered.some((rule) => rule.id === 'dangerous-delete')).toBe(false);
  });
});

describe('规则表静态性质（防止后续改动悄悄退化）', () => {
  it('patterns / negativePatterns 全部是 RegExp 实例且 source 非空', () => {
    for (const rule of RISK_RULES) {
      for (const pattern of [...rule.patterns, ...(rule.negativePatterns ?? [])]) {
        expect(pattern, `${rule.id} 必须是 RegExp`).toBeInstanceOf(RegExp);
        expect(pattern.source.length, `${rule.id} 正则不得为空`).toBeGreaterThan(0);
      }
    }
  });

  it('prefilter（若有）必须是小写子串（大小写不敏感粗筛的约定）', () => {
    for (const rule of RISK_RULES) {
      for (const needle of rule.prefilter ?? []) {
        expect(needle, `${rule.id} prefilter 必须已是小写`).toBe(needle.toLowerCase());
      }
    }
  });

  it('三个风险等级都有规则（否则 UI 的分级配色永远用不全）', () => {
    const levels = new Set(RISK_RULES.map((rule) => rule.level));
    expect(levels.has('high')).toBe(true);
    expect(levels.has('medium')).toBe(true);
  });

  it('每条规则都能答出「为什么是风险」与「看哪一行」（人话，非占位符）', () => {
    for (const rule of RISK_RULES) {
      expect(rule.why.length, `${rule.id} why 过短`).toBeGreaterThan(4);
      expect(rule.suggestion.length, `${rule.id} suggestion 过短`).toBeGreaterThan(4);
      expect(rule.why, `${rule.id} why 是占位符`).not.toBe('TODO');
      expect(rule.suggestion, `${rule.id} suggestion 是占位符`).not.toBe('TODO');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// W8 防 ReDoS 回归（2026-10-27 实测事故：单规则 10 万字符长行 1766ms）
// ═══════════════════════════════════════════════════════════

describe('W8 防 ReDoS（10 万字符长行 · 预算 <20ms）', () => {
  /** 构造 10 万字符长行：前半填充 + 触发特征 + 后半填充（确保正则真的在长串上执行）。 */
  function longLine(trigger: string): string {
    const half = 50_000;
    return `+${'a'.repeat(half)}${trigger}${'a'.repeat(half)}`;
  }

  it('每条规则在 10 万字符长行上都 <20ms（无 O(n²) 回溯）', () => {
    for (const rule of RISK_RULES) {
      const line = longLine(rule.prefilter?.[0] ?? '');
      const started = performance.now();
      analyzeDiff(line, [rule]);
      const elapsed = performance.now() - started;
      // 事故前：dependency-change 单条 1766ms（预算 20ms）
      expect(elapsed, `${rule.id} 单规则长行耗时 ${elapsed.toFixed(1)}ms`).toBeLessThan(20);
    }
  });

  it('dependency-change 修 ReDoS 后仍命中真实依赖形态（不许把功能改没）', () => {
    const hits = (diff: string): string[] =>
      analyzeDiff(diff, RISK_RULES)
        .map((hit) => hit.ruleId)
        .filter((id) => id === 'dependency-change');
    // ① package.json 真实形态（键与版本号都带引号）
    expect(hits('+"vitest": "^4.1.10",')).toEqual(['dependency-change']);
    // ② 无引号键（对象字面量 / 文本形态）
    expect(hits('+  zod: "~3.23.8",')).toEqual(['dependency-change']);
    // ③ 依赖段整体出现
    expect(hits('+  "devDependencies": {')).toEqual(['dependency-change']);
    // ④ 反例：普通字符串带冒号不应命中（防放宽成误报源）
    expect(hits('+const label = "timeout: 5000";')).toEqual([]);
  });
});
