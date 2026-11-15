/**
 * `handoff list / prune` 的**汇总行与 --yes 摘要行**（v5.4 候选 1，用户明确要求）。
 *
 * ## 为什么单独一个文件
 *
 * `handoff-prune.test.ts` 验的是「判定对不对」（四类结论），本文件验的是
 * 「**说清楚了没有**」。用户的原话：「否则用户看到『可清理 145 个』不知道是
 * 『会话文件查无』还是『项目路径不存在』」——判定对、文案含糊，等于没修。
 *
 * ## 每条断言对准一种「说糊了」
 *
 * - 四类合成一个数字 ⇒ 用户没法决定要不要删（本文件的主判据）；
 * - `--yes` 只喊「删了 N 个」⇒ 删完无法复盘（`--yes` 是跳过审批，不是跳过摘要）；
 * - 摘要行出现在删除之后 ⇒ 想看时东西已经没了。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHandoffCommand } from '../../src/cli/handoff-prune';
import { fmt, t } from '../../src/i18n';
import type { SessionFileState } from '../../src/store/session';

let root: string;

/** 造一个交接单目录（结构与真实产物一致：首行 `# 标题` 在头部之前）。 */
function makeDir(name: string, opts: { project: string; session?: string }): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const text = [
    '# 交接单 — demo',
    `> 项目: ${opts.project}`,
    `> 会话: ${opts.session ?? '无'}`,
    '> 写入时间: 2026-11-15T00:00:00.000Z',
    '',
    '## ① 做到哪一步',
    '无记录',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'handoff.md'), text, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ccai-prune-summary-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 四类目录，**数量刻意不同**（1 / 2 / 3 / 4）。
 *
 * 为什么不用「每类各 1 个」：四个数字相同时，「摘要行里出现了 1」这种断言分不清
 * 哪个字段被填错了（字段错位也照样命中）。数量各不相同，整行比较才有牙。
 *
 * - verified ×1：带真实会话 id + 会话文件核验存在 ⇒ 保留·证据；
 * - unverified ×2：带真实会话 id + 会话目录读不到（unknown）⇒ 保留·未核验；
 * - alive ×3：项目仍在、无会话 id ⇒ 保留·项目在；
 * - prunable ×4：带真实会话 id + 会话文件查无（absent）+ 项目不在 ⇒ 可清理。
 */
const VERIFIED_IDS = ['20261115-120000-001'];
const UNVERIFIED_IDS = ['20261115-120000-002', '20261115-120000-003'];
const PRUNABLE_IDS = [
  '20261115-120000-004',
  '20261115-120000-005',
  '20261115-120000-006',
  '20261115-120000-007',
];
const ALIVE_COUNT = 3;

function seedFourCategories(): void {
  VERIFIED_IDS.forEach((session, i) => {
    makeDir(`verified-${'a'.repeat(12)}${i}`, { project: `C:\\tmp\\gone-v${i}`, session });
  });
  UNVERIFIED_IDS.forEach((session, i) => {
    makeDir(`unverified-${'b'.repeat(10)}${i}`, { project: `C:\\tmp\\gone-u${i}`, session });
  });
  for (let i = 0; i < ALIVE_COUNT; i += 1) {
    makeDir(`alive-${'c'.repeat(13)}${i}`, { project: root, session: '无' });
  }
  PRUNABLE_IDS.forEach((session, i) => {
    makeDir(`prunable-${'d'.repeat(11)}${i}`, { project: `C:\\tmp\\gone-d${i}`, session });
  });
}

/** 三态注入：按 id 分组给值（**绝不落到默认实现**去读真实 sessions/）。 */
const stateById = (id: string): SessionFileState => {
  if (VERIFIED_IDS.includes(id)) return 'exists';
  if (UNVERIFIED_IDS.includes(id)) return 'unknown';
  return 'absent';
};

/** 摘要行：按字典模板里「第一个占位符之前的固定开头」找，不绑任何中文字面量。 */
function summaryLineOf(lines: string[]): string {
  const prefix = t().handoff.summary.split('{')[0] ?? '';
  return lines.find((l) => prefix !== '' && l.startsWith(prefix)) ?? '';
}

/** 期望的四类计数（seedFourCategories 的结构决定了这四个数）。 */
const EXPECTED = {
  keepRealSession: VERIFIED_IDS.length,
  keepUnverified: UNVERIFIED_IDS.length,
  keepProjectExists: ALIVE_COUNT,
  prune: PRUNABLE_IDS.length,
};

describe('汇总行：四类分开计数（不是一个「可清理 N 个」）', () => {
  it('四类各自的数字都出现在同一行里，且能对上（整行等于字典模板 ⇒ 数字没错位）', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'list',
      root,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    // 正例自证：摘要行真的找到了（否则下面的整行比较等于没跑）
    const summary = summaryLineOf(lines);
    expect(summary).not.toBe('');
    /**
     * 与产品同源（v5.4 候选 3 A 类）：期望值由**字典模板 + fmt** 拼出，四类数量刻意
     * 互不相同（1/2/3/4）⇒ 任何一个字段填错/错位都会让整行不等。
     */
    expect(summary).toBe(fmt(t().handoff.summary, EXPECTED));
    expect(EXPECTED).toEqual({
      keepRealSession: 1,
      keepUnverified: 2,
      keepProjectExists: 3,
      prune: 4,
    });
  });

  it('否定面：**不许**只给一个孤零零的「可清理 N 个」——模板必须自带四个占位符', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'list',
      root,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    /**
     * 这条是**结构断言**，不是文案断言。理由要写清：上一条是「同一份模板两边比」，
     * 它抓得住「数字填错」，但抓不住「模板本身被删掉一个字段」——那种改动两侧一起变，
     * 整行比较照样绿。用户明确要求的是「四类分开计数」，所以占位符**必须**四个都在：
     * 少一个 `{keepUnverified}`，屏幕上就再也看不见「读不到会话目录」这一档，
     * 而用户恰恰要靠它决定「这次能不能放心删」。
     */
    const template = t().handoff.summary;
    for (const key of Object.keys(EXPECTED)) {
      expect(template).toContain(`{${key}}`);
    }
    // 渲染结果里四类数字一个都不能少（含 unknown 那一档：EXPECTED.keepUnverified = 2）
    const summary = summaryLineOf(lines);
    expect(summary).toContain(String(EXPECTED.keepUnverified));
  });

  it('阶梯自证：三态各换一次 ⇒「未核验」与「可清理」两个数字往相反方向变（恒 0 / 恒满的废实现都过不去）', () => {
    seedFourCategories();
    /** 带真实会话 id 的目录共 1 + 2 + 4 = **7** 个（verified / unverified / prunable），项目仍在的 3 个。 */
    const SESSION_DIRS = VERIFIED_IDS.length + UNVERIFIED_IDS.length + PRUNABLE_IDS.length;
    expect(SESSION_DIRS).toBe(7);

    const countsOf = (stateOf: (id: string) => SessionFileState): Record<string, string> => {
      const lines: string[] = [];
      runHandoffCommand({
        action: 'list',
        root,
        sessionStateOf: stateOf,
        log: (m) => lines.push(m),
      });
      const summary = summaryLineOf(lines);
      /**
       * 从**模板本身**生成取值正则：把每个 `{key}` 换成 `(-?\d+)`，字面段做转义。
       * 好处：不写任何中文锚点（换语言自动跟随），也不写死字段顺序——顺序变了仍能取到。
       */
      const tpl = t().handoff.summary;
      const holders = (tpl.match(/\{(\w+)\}/g) ?? []).map((h) => h.slice(1, -1));
      const literals = tpl
        .split(/\{\w+\}/)
        .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const pattern = literals.reduce(
        (acc, seg, i) => `${acc}${seg}${i < holders.length ? '(-?\\d+)' : ''}`,
        '',
      );
      const m = new RegExp(pattern).exec(summary);
      const out: Record<string, string> = {};
      holders.forEach((key, i) => {
        out[key] = m?.[i + 1] ?? '(缺失)';
      });
      return out;
    };

    // 都判 unknown ⇒ 7 个全部「未核验」，一个都不可清理
    expect(countsOf(() => 'unknown')).toMatchObject({ keepUnverified: '7', prune: '0' });
    // 都判 absent ⇒ 未核验 0；7 个带真实 id 的都进可清理（alive 无会话 id、项目仍在 ⇒ 保留）
    expect(countsOf(() => 'absent')).toMatchObject({ keepUnverified: '0', prune: '7' });
    // 都判 exists ⇒ 未核验 0，且全是证据 ⇒ 可清理 0、已核验 7
    expect(countsOf(() => 'exists')).toMatchObject({
      keepUnverified: '0',
      prune: '0',
      keepRealSession: '7',
    });
  });
});

/** 模板里「第一个占位符之前的固定开头」——用于找某句话，而不绑它的措辞。 */
function prefixOf(template: string): string {
  return template.split('{')[0]?.trimEnd() ?? '';
}

/** 期望的 `--yes` 摘要行（四类计数 + 「其中几个会话文件查无」）。 */
function expectedConfirm(): string {
  return fmt(t().handoff.confirmYes, {
    count: EXPECTED.prune,
    absentCount: PRUNABLE_IDS.length, // 4 个可清理全部是「形状合法但会话文件查无」
    keepRealSession: EXPECTED.keepRealSession,
    keepUnverified: EXPECTED.keepUnverified,
    keepProjectExists: EXPECTED.keepProjectExists,
  });
}

describe('--yes 摘要行：跳过审批，不跳过摘要', () => {
  it('真删前先念一遍：将删几个（其中几个会话查无）+ 保留三类各几个 —— 整行等于模板', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'prune',
      root,
      yes: true,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    const prefix = prefixOf(t().handoff.confirmYes);
    // 正例自证：摘要行真的出现了（否则下面的整行比较等于没跑）
    const confirm = lines.find((l) => prefix !== '' && l.startsWith(prefix)) ?? '';
    expect(confirm).not.toBe('');

    /**
     * 与产品同源（A 类）：整行比较。四个计数刻意互不相同（4 可清理 / 1 已核验 /
     * 2 未核验 / 3 项目仍在），任何一个字段填错（例如把 absentCount 写成 0，
     * 或把 unknown 算进「查无」）都会让整行不等。
     */
    expect(confirm).toBe(expectedConfirm());

    /**
     * 结构断言（补整行比较抓不到的那半边）：摘要必须**同时**提到「未核验」这一档。
     * 模板里删掉 `{keepUnverified}` 时，上面那条整行比较会跟着一起变、照样绿；
     * 而用户恰恰要靠「有几个是读不到会话目录」判断这次删除要不要停手。
     */
    const template = t().handoff.confirmYes;
    for (const key of [
      'count',
      'absentCount',
      'keepRealSession',
      'keepUnverified',
      'keepProjectExists',
    ]) {
      expect(template).toContain(`{${key}}`);
    }
  });

  it('摘要行必须出现在「已删除」**之前**（想看的时候东西还在）', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'prune',
      root,
      yes: true,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    const confirmIdx = lines.indexOf(expectedConfirm());
    const prunedIdx = lines.indexOf(fmt(t().handoff.pruned, { count: EXPECTED.prune }));
    expect(confirmIdx).toBeGreaterThanOrEqual(0);
    expect(prunedIdx).toBeGreaterThanOrEqual(0);
    expect(confirmIdx).toBeLessThan(prunedIdx);
  });

  it('dry-run（不带 --yes）**不许**念摘要行（那句话只属于真删）', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'prune',
      root,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    // 否定面按模板前缀判定：不写中文字面量，产品换措辞这里自动跟随
    const prefix = prefixOf(t().handoff.confirmYes);
    expect(prefix).not.toBe('');
    expect(lines.some((l) => l.startsWith(prefix))).toBe(false);
    expect(lines).not.toContain(fmt(t().handoff.pruned, { count: EXPECTED.prune }));
  });
});
