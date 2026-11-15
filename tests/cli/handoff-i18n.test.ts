/**
 * handoff 文案的 i18n 护栏（v5.4 候选 3，C 类）。
 *
 * ## 为什么需要这一层
 *
 * `handoff-prune.test.ts` / `handoff-prune-summary.test.ts` 里的断言原来是把
 * **中文字面量**抄进测试（`'可清理'` / `'保留·证据'` / `'将删'`……），而
 * `t()` 的 `currentLocale` 默认 `'zh'`、只有 CLI 启动时才 `setLocale()`。
 * 后果不是「已经红了」，而是**「跨语言这件事从来没被验证过」**：任何人在同一
 * worker 里调一次 `setLocale('en')` 又忘了复位，那批断言就会立刻红，而红的原因
 * 是测试写法、不是产品缺陷——最容易的误判是「把文案改坏去迁就测试」
 * （同族：v5.0 T22 的 `LUMEN_LOCALE` 泄漏、2026-11-14 候选 4 的 `BASE_ENV` 注回）。
 *
 * ## 本文件三条（对应 v5.4 候选 3 的 C 类）
 *
 * 1. `setLocale('en')` **正向**：同一个命令、同一批目录，屏幕上真的换成英文模板；
 * 2. **键非空**：`handoff` 字典任何语言下都不许有空串（空串在屏幕上是一行消失，不报错）；
 * 3. **双语不同**：`en` 里抄一遍中文这种「假翻译」必须被抓。
 *
 * ## 状态隔离
 *
 * `setLocale` 是模块级可变状态（`AGENTS.md`「进程级全局状态隔离」条款列名的示例函数），
 * 故 `afterEach` **无条件复位** `'zh'`：不指望用例执行顺序。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHandoffCommand } from '../../src/cli/handoff-prune';
import { DICTS, fmt, setLocale } from '../../src/i18n';
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
  root = mkdtempSync(path.join(os.tmpdir(), 'ccai-handoff-i18n-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  // 进程级全局状态必须复位（不指望执行顺序；`setLocale` 就在 AGENTS 的示例清单里）
  setLocale('zh');
});

describe('handoff 文案的 i18n 护栏', () => {
  it("setLocale('en') 正向：同一个命令、同一批目录，屏幕上真的换成英文模板", () => {
    makeDir('gone-aaaaaaaaaaaa', { project: 'C:\\tmp\\gone-proj' });
    /** 会话文件状态注入（绝不落到默认实现去读开发者真实 sessions/）。 */
    const sessionsAbsent = (): SessionFileState => 'absent';

    const render = (): string[] => {
      const lines: string[] = [];
      runHandoffCommand({
        action: 'list',
        root,
        sessionStateOf: sessionsAbsent,
        log: (m) => lines.push(m),
      });
      return lines;
    };

    // ① 正例自证：切换**之前**渲染出来的确实是中文模板（否则「切换生效」根本证不出来）
    const zhLines = render();
    const zh = DICTS.zh.handoff;
    expect(zhLines).toContain(fmt(zh.title, { path: root, total: 1 }));

    setLocale('en');
    const enLines = render();
    const en = DICTS.en.handoff;

    // ② 正向：英文模板整行命中（不是「也出现英文字母」，是**整行等于字典模板**）
    expect(enLines).toContain(fmt(en.title, { path: root, total: 1 }));
    expect(enLines).toContain(
      fmt(en.summary, {
        keepRealSession: 0,
        keepUnverified: 0,
        keepProjectExists: 0,
        prune: 1,
      }),
    );
    expect(enLines).toContain(en.listHint);

    // ③ 否定面：切到 en 之后，中文模板必须**不再出现**（免得「中英都命中」也算绿）
    expect(enLines).not.toContain(fmt(zh.title, { path: root, total: 1 }));
    expect(enLines).not.toContain(
      fmt(zh.summary, {
        keepRealSession: 0,
        keepUnverified: 0,
        keepProjectExists: 0,
        prune: 1,
      }),
    );

    // 变异探针：把上面那句 `setLocale('en')` 删掉 ⇒ 本用例必须红（② 全落空、③ 反而命中）。
  });

  it('键非空：handoff 字典在 zh / en 下都不许有空串（空串 = 屏幕上少一行，且不报错）', () => {
    for (const locale of ['zh', 'en'] as const) {
      const dict: Record<string, string> = DICTS[locale].handoff;
      const keys = Object.keys(dict);
      // 正例自证：字典真的被读到了（否则下面「没有空串」恒真）
      expect(keys.length).toBeGreaterThan(0);
      const empty = keys.filter((k) => typeof dict[k] !== 'string' || dict[k].trim() === '');
      expect(empty).toEqual([]);
    }
  });

  it('双语不同 + 占位符一致：每个键的文案必须不同，且 {占位符} 集合必须与 zh 相同', () => {
    const zh: Record<string, string> = DICTS.zh.handoff;
    const en: Record<string, string> = DICTS.en.handoff;

    // 先钉「键集合一致」：少一个键在运行时就是 undefined 文案
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());

    /**
     * 有意同形的键（目前为空）：只有当某个键**真的不该翻译**（例如纯命令片段）才登记，
     * 且必须写明理由——否则一律要求双语不同。
     */
    const INTENTIONALLY_SAME: string[] = [];

    /**
     * 把两边取值**先取成元组**再断言：`zh[k]` 在 `noUncheckedIndexedAccess` 下是
     * `string | undefined`，直接在 filter 里比较会让 `tsc` 报 TS2345（实测踩过），
     * 用 `?? ''` 落成 string 也顺带保证「键缺失」不会被误当成「文案相同」。
     */
    const pairs = Object.keys(zh).map((k) => [k, zh[k] ?? '', en[k] ?? ''] as const);

    const same = pairs.filter(([k, a, b]) => INTENTIONALLY_SAME.includes(k) === false && a === b);
    expect(same.map(([k]) => k)).toEqual([]);

    /**
     * ## 占位符一致性（这一条是**实测补上来的**，不是预防性设计）
     *
     * 第一版只比「文案是否不同」，然后跑变异探针 M2（把 `en.handoff.summary` 里的
     * `{keepUnverified}` 删掉）——**全绿**。原因：`prune-summary` 用例默认跑在 zh 下，
     * 结构断言读的也是 zh 模板，于是「英文模板少了一档」这件事在整套测试里**没有任何
     * 一条会红**，而真实后果正是用户明确要求避免的那个：英文用户看不到「有几个是读不到
     * 会话目录」，却照样能敲 `--yes` 删东西。
     *
     * 所以判据不能只是「两种语言文案不同」，还必须是「结构相同」：
     * 同一个键在 zh / en 下的 `{占位符}` 集合必须一致（多、少、改名都算错）。
     */
    const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    const mismatched = pairs.filter(([, a, b]) => {
      const pa = placeholders(a);
      const pb = placeholders(b);
      return pa.length !== pb.length || pa.some((p, i) => p !== pb[i]);
    });
    expect(mismatched.map(([k]) => k)).toEqual([]);
    // 正例自证：占位符抽取真的在工作（否则「没有不一致」恒真）
    expect(placeholders(DICTS.zh.handoff.summary)).toEqual([
      '{keepProjectExists}',
      '{keepRealSession}',
      '{keepUnverified}',
      '{prune}',
    ]);
  });
});
