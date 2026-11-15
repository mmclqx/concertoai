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

/** 四类各一个目录：已核验证据 / 未核验 / 项目仍在 / 可清理（项目不在 + 会话查无）。 */
function seedFourCategories(): void {
  makeDir('verified-aaaaaaaaaaaa', {
    project: 'C:\\tmp\\gone-a',
    session: '20261115-120000-001',
  });
  makeDir('unverified-bbbbbbbbbbbb', {
    project: 'C:\\tmp\\gone-b',
    session: '20261115-120000-002',
  });
  makeDir('alive-cccccccccccc', { project: root, session: '无' });
  makeDir('prunable-dddddddddddd', {
    project: 'C:\\tmp\\gone-d',
    session: '20261115-120000-004',
  });
}

/** 按 id 给三态：001 verified / 002 unknown / 004 absent；其余 absent。 */
const stateById = (id: string): SessionFileState => {
  if (id === '20261115-120000-001') return 'exists';
  if (id === '20261115-120000-002') return 'unknown';
  return 'absent';
};

describe('汇总行：四类分开计数（不是一个「可清理 N 个」）', () => {
  it('四类各自的数字都出现在同一行里，且能对上（正例自证：数字是真的）', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'list',
      root,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    const summary = lines.find((l) => l.includes('可清理')) ?? '';
    expect(summary).not.toBe('');
    // 每一类都要有名字与数字：会话已核验 1 / 会话未核验 1 / 项目仍在 1 / 可清理 1
    expect(summary).toContain('会话已核验 1');
    expect(summary).toContain('会话未核验 1');
    expect(summary).toContain('项目仍在 1');
    expect(summary).toContain('可清理 1');
  });

  it('否定面：**不许**只给一个孤零零的「可清理 N 个」而不说未核验（那是本次要修的病）', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'list',
      root,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    const summary = lines.find((l) => l.includes('可清理')) ?? '';
    // 有 unknown 在场时，行里必须出现「未核验」——否则用户分不清那 1 个可清理是什么原因
    expect(summary).toContain('未核验');
  });

  it('阶梯自证：三态各换一次 ⇒「未核验」与「可清理」两个数字往相反方向变（恒 0 / 恒满的废实现都过不去）', () => {
    seedFourCategories();
    /** 本组共有 **3** 个带真实会话 id 的目录（verified / unverified / prunable）+ 1 个项目仍在的。 */
    const countsOf = (
      stateOf: (id: string) => SessionFileState,
    ): { unverified: string; prune: string } => {
      const lines: string[] = [];
      runHandoffCommand({
        action: 'list',
        root,
        sessionStateOf: stateOf,
        log: (m) => lines.push(m),
      });
      const summary = lines.find((l) => l.includes('可清理')) ?? '';
      return {
        unverified: /会话未核验 (\d+)/.exec(summary)?.[1] ?? '(缺失)',
        prune: /可清理 (\d+)/.exec(summary)?.[1] ?? '(缺失)',
      };
    };

    // 都判 unknown ⇒ 3 个全部「未核验」，一个都不可清理
    expect(countsOf(() => 'unknown')).toEqual({ unverified: '3', prune: '0' });
    // 都判 absent ⇒ 未核验 0；3 个带真实 id 的都进可清理（alive 无会话 id、项目仍在 ⇒ 保留）
    expect(countsOf(() => 'absent')).toEqual({ unverified: '0', prune: '3' });
    // 都判 exists ⇒ 未核验 0，且全是证据 ⇒ 可清理 0
    expect(countsOf(() => 'exists')).toEqual({ unverified: '0', prune: '0' });
  });
});

describe('--yes 摘要行：跳过审批，不跳过摘要', () => {
  it('真删前先念一遍：将删几个（其中几个会话查无）+ 保留三类各几个', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'prune',
      root,
      yes: true,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    const confirm = lines.find((l) => l.includes('将删')) ?? '';
    expect(confirm).not.toBe('');
    expect(confirm).toContain('将删 1 个');
    expect(confirm).toContain('1 个是会话文件查无'); // 那个 absent 的 prunable
    expect(confirm).toContain('会话已核验');
    expect(confirm).toContain('读不到会话目录'); // unknown 也要念出来
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
    const confirmIdx = lines.findIndex((l) => l.includes('将删'));
    const prunedIdx = lines.findIndex((l) => l.includes('已删除'));
    expect(confirmIdx).toBeGreaterThanOrEqual(0);
    expect(prunedIdx).toBeGreaterThanOrEqual(0);
    expect(confirmIdx).toBeLessThan(prunedIdx);
  });

  it('dry-run（不带 --yes）**不许**出现「将删」字样（那句话只属于真删）', () => {
    seedFourCategories();
    const lines: string[] = [];
    runHandoffCommand({
      action: 'prune',
      root,
      sessionStateOf: stateById,
      log: (m) => lines.push(m),
    });
    expect(lines.join('\n')).not.toContain('将删');
  });
});
