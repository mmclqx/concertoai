/**
 * 发版一致性：README 状态行里的产品版本必须跟着 `package.json` 走（v5.5 候选 2，2026-11-16）。
 *
 * ## 为什么这条必须存在（不是「给文档写测试」的形式主义）
 *
 * v5.4.0 发版时，`package.json` / `src/version.ts` 都改成了 5.4.0，**README 状态行还写着 v5.3.0**
 * 外加旧读数（2816 用例 / 189 文件 / 双环境）。它**不是**靠「我记得 README 也有版本号」发现的，
 * 是靠「扫全仓 `5.3.0`」（793 个文件）扫出来的 —— 这两者的区别就是「碰运气」与「有判据」的区别。
 *
 * **为什么 `sync-version.mjs` 挡不住**：它只同步 `package.json` → `src/version.ts` 的 `VERSION`
 * 常量。README 是 Markdown，`npm version` 的钩子根本不知道它存在。所以「版本三处同源」
 * 实际只有两处被自动同步，第三处（README）**唯一的保真机制就是本文件**。
 *
 * ## 判据的锚点（这一节是这个文件最容易写坏的地方）
 *
 * README 状态行（`> 版本：**v5.4.0**（…）`）里**有 6 个三段式版本号**：
 *
 * ```text
 * 带 v 前缀：["v5.4.0"]                                          ← 1 个，产品版本
 * 不带 v 的：["5.4.0","4.6.7","4.1.12","8.2.4","3.3.18","1.2.2"]  ← 5 个依赖版本
 * ```
 *
 * 所以判据取 `v(\d+\.\d+\.\d+)` —— **依赖版本都没有 `v` 前缀**，天然不命中。
 * 若哪天把判据改成「行内全部三段式」，T4（否定面）会立刻红：那是**故意**的，
 * 它挡的正是「护栏抓了依赖版本」这个坏法。
 *
 * 锚点是**语义锚点**（`> 版本：` 开头的行），不是行号、也不是「全文第一个三段式」——
 * 文末「历史版本速览」里全是 `v4.0` / `v3.2` 这类两段式，全文扫描会把它们卷进来。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { VERSION } from '../../src/version';

const REPO = process.cwd();
const README_PATH = path.join(REPO, 'README.md');
const PKG_PATH = path.join(REPO, 'package.json');

/** 状态行锚点：语义锚点，不是行号。改 README 排版时这里和 README 一起改。 */
const VERSION_LINE_ANCHOR = '> 版本：';

/** 产品版本必须带 `v` 前缀 —— 这正是「依赖版本（4.6.7 等）不会被抓」的机制。 */
const PRODUCT_VERSION_RE = /v(\d+\.\d+\.\d+)/g;

type ParseResult =
  | { kind: 'ok'; line: string; lineNo: number; version: string }
  | { kind: 'missing-line' }
  | { kind: 'ambiguous'; line: string; lineNo: number; candidates: string[] };

/**
 * 从 README 正文解析产品版本。
 *
 * **fail-closed**：读不到 / 读到多个都**不返回默认值**，而是返回可归因的失败形状。
 * 这一条是「读不到 ≠ 不存在」家族的落地（v5.4 候选 1 的 prune 判据同源）：
 * 用 `?? ''` 兜底会让「有人删了状态行」静默变绿。
 */
function parseProductVersion(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const lineNo = lines.findIndex((l) => l.trimStart().startsWith(VERSION_LINE_ANCHOR));
  if (lineNo < 0) return { kind: 'missing-line' };
  const line = lines[lineNo] as string;
  const candidates = [...line.matchAll(PRODUCT_VERSION_RE)].map((m) => m[1] as string);
  if (candidates.length !== 1) return { kind: 'ambiguous', line, lineNo: lineNo + 1, candidates };
  return { kind: 'ok', line, lineNo: lineNo + 1, version: candidates[0] as string };
}

/** 把失败形状拼成**指路式**报错（用户裁决 ④：不是「红了你看着办」）。 */
function explain(result: ParseResult, readmeText: string): string {
  if (result.kind === 'missing-line') {
    const related = readmeText
      .split(/\r?\n/)
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('版本'))
      .slice(0, 5)
      .map(({ l, i }) => `    ${i + 1}: ${l.trim().slice(0, 100)}`)
      .join('\n');
    return [
      `README 里找不到状态行（锚点：以「${VERSION_LINE_ANCHOR}」开头的行）。`,
      '若已改用 badge 方案（不再写版本号），请同步改本判据 —— 删掉 T1/T2 或改成断言 badge 的 href 版本；',
      '若只是排版变了，把状态行改回以「> 版本：」开头即可。',
      related
        ? `正文里含「版本」字样的行（供定位）：\n${related}`
        : '（正文里连「版本」字样都没有）',
    ].join('\n');
  }
  if (result.kind === 'ambiguous') {
    return [
      `README 状态行解析出 ${result.candidates.length} 个候选（要求恰好 1 个）：${JSON.stringify(result.candidates)}`,
      `锚点：以「${VERSION_LINE_ANCHOR}」开头的行。`,
      `当前行（第 ${result.lineNo} 行）：${result.line.trim()}`,
      '产品版本必须带 v 前缀且只出现一次；依赖版本（如 zod 4.6.7）不带 v，本不该被命中 ——',
      '若真出现了多个 vX.Y.Z，请确认状态行里是否混进了第二个产品版本。',
    ].join('\n');
  }
  return `README 状态行（第 ${result.lineNo} 行）解析出 ${result.version}：${result.line.trim().slice(0, 120)}`;
}

function readReadme(): string {
  return readFileSync(README_PATH, 'utf8');
}

function readPkgVersion(): string {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8')).version as string;
}

describe('发版一致性：README 状态行必须跟着版本走', () => {
  it('T1：README 里的产品版本 == package.json 的 version（主判据）', () => {
    const text = readReadme();
    const parsed = parseProductVersion(text);
    const pkgVersion = readPkgVersion();
    expect(parsed.kind, explain(parsed, text)).toBe('ok');
    if (parsed.kind !== 'ok') return; // 类型收窄，上一行已断言
    expect(
      parsed.version,
      `README 状态行（第 ${parsed.lineNo} 行）写的是 v${parsed.version}，而 package.json 是 ${pkgVersion}。\n` +
        `发版时请一并改 README：把 v${parsed.version} 换成 v${pkgVersion}（含该行的用例数/文件数读数）。\n` +
        `当前行：${parsed.line.trim()}`,
    ).toBe(pkgVersion);
  });

  it('T2：README 里的产品版本 == src/version.ts 的 VERSION（sync-version.mjs 管不到的第三处）', () => {
    // 为什么单列一条而不是并进 T1：sync-version.mjs 只同步 package.json → src/version.ts。
    // 若有人手改 version.ts 却忘了 package.json（或反过来），T1 与 T2 分别报出**哪一侧**漏了；
    // 合成一条时，报错只说「不一致」，看不出该去改哪一处。
    const text = readReadme();
    const parsed = parseProductVersion(text);
    expect(parsed.kind, explain(parsed, text)).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(
      parsed.version,
      `README 状态行（第 ${parsed.lineNo} 行）写的是 v${parsed.version}，而 src/version.ts 的 VERSION 是 ${VERSION}。\n` +
        `注意：npm 的 version 钩子（scripts/sync-version.mjs）**只**同步 package.json → src/version.ts，README 不在其中。\n` +
        `当前行：${parsed.line.trim()}`,
    ).toBe(VERSION);
  });

  it('T3：状态行必须存在且解析出恰好 1 个候选（fail-closed：缺失 / 多个都不许静默过）', () => {
    const text = readReadme();
    const parsed = parseProductVersion(text);

    // 报错三要素（用户裁决 ④ + 补充要求）：锚点是什么 / 当前行是什么 / 解析出几个候选。
    expect(parsed.kind, explain(parsed, text)).toBe('ok');
    if (parsed.kind !== 'ok') return;

    // 正例自证：解析器对已知形态确实给出 1 个候选（否则下面「恰好 1 个」是空转）
    const candidates = [...parsed.line.matchAll(PRODUCT_VERSION_RE)].map((m) => m[1]);
    expect(candidates, explain(parsed, text)).toHaveLength(1);
    // 且候选就是返回的那个（防「返回第一个、断言最后一个」的错位）
    expect(candidates[0]).toBe(parsed.version);
  });

  it('T4（否定面）：解析结果不含任何依赖版本号 —— 证明判据没被 4.6.7 / 4.1.12 这类数字带跑', () => {
    /**
     * 这一条是**关键否定面**。README 状态行里同时写着 zod 4.6.7、vitest 4.1.12、
     * vite ≥8.2.4、nanoid ≥3.3.18、source-map-js ≥1.2.2 —— 五个「三段式数字」。
     * 若判据写成「行内第一个三段式」或「行内全部三段式」，就会命中它们：
     *   · 第一个三段式 → 恰好也是 5.4.0（巧合，暂时绿，但一旦人家把依赖挪到前面就红）；
     *   · 全部三段式 → 立刻红（T3 的 candidates.length 会变成 6）。
     * 所以这里**显式列出**当前状态行里的依赖版本，断言解析器一个都没返回。
     *
     * 依赖升级时这一行要跟着改（这是有意的：它记录「这行当时有哪些干扰项」）。
     * 但它**不钉版本值本身**，只要求「解析结果不等于它们」。
     */
    const DEPENDENCY_VERSIONS_IN_STATUS_LINE = ['4.6.7', '4.1.12', '8.2.4', '3.3.18', '1.2.2'];
    const text = readReadme();
    const parsed = parseProductVersion(text);
    expect(parsed.kind, explain(parsed, text)).toBe('ok');
    if (parsed.kind !== 'ok') return;
    for (const dep of DEPENDENCY_VERSIONS_IN_STATUS_LINE) {
      expect(
        parsed.version,
        `解析出的产品版本是 ${parsed.version}，而 ${dep} 是状态行里的**依赖**版本 —— 判据抓错对象了`,
      ).not.toBe(dep);
    }
    // 探针通电：这些依赖版本**确实**出现在状态行里（否则上一段循环是空转）
    const reallyThere = DEPENDENCY_VERSIONS_IN_STATUS_LINE.filter((d) => parsed.line.includes(d));
    expect(
      reallyThere.length,
      `否定面要成立，前提是状态行里真的有依赖版本。实测命中 ${reallyThere.length} 个（期望 ≥1）。\n` +
        `当前行：${parsed.line.trim()}\n` +
        '若依赖已全部移出状态行，请同步本用例的列表 —— 否则这段断言变成了空转。',
    ).toBeGreaterThan(0);
  });
});
