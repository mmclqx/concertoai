/**
 * `concertoai handoff list / prune`（v5.3 B4，2026-11-15 用户裁决）。
 *
 * ## 这一层守什么
 *
 * 清理是**删用户磁盘上的东西**，错的代价不可逆。故每条断言都对准一个具体的误删方式：
 * - 默认不 dry-run ⇒ 用户只是「看一眼」就删了东西（与 metrics 默认 off 的取向冲突）；
 * - 把带真实会话 id 的交接单当垃圾 ⇒ **擦掉唯一的证据**（「那次为什么退出」）；
 * - 把项目仍在的交接单删掉 ⇒ 下次进项目看到「无记录」，用户以为自己白干了；
 * - 判据写成「目录名里有 hash 就删」⇒ 删掉自己正在用的项目。
 *
 * ## 探针纪律
 *
 * 全部在 `mkdtemp` 出来的临时根目录里跑（**不传默认根**）：`pruneHandoffs()` 的 `root`
 * 是必传/可注入的，用例一律显式传——`handoffsDir()` 走 `os.homedir()`，而默认隔离
 * （tests/setup.ts）已经把它指到临时目录，两道保险都在。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyHandoffDir,
  headerValue,
  pruneHandoffs,
  runHandoffCommand,
  scanHandoffDirs,
} from '../../src/cli/handoff-prune';
import { fmt, t } from '../../src/i18n';
import type { SessionFileState } from '../../src/store/session';

let root: string;

/** 造一个交接单目录（`handoff.md` 结构与真实产物一致：首行 `# 标题` 在头部之前）。 */
function makeDir(
  name: string,
  opts: { project?: string; session?: string; noFile?: boolean } = {},
): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  if (opts.noFile === true) {
    return;
  }
  const text = [
    '# 交接单 — demo',
    `> 项目: ${opts.project ?? 'C:\\\\tmp\\\\demo'}`,
    `> 会话: ${opts.session ?? '无'}`,
    '> 写入时间: 2026-11-15T00:00:00.000Z',
    '> 退出原因: completed',
    '',
    '## ① 做到哪一步',
    '无记录',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'handoff.md'), text, 'utf8');
}

/**
 * 某行是否以「字典模板里第一个 `{...}` 之前的固定开头」起头（A 类否定面用）。
 *
 * 为什么不直接断言「屏幕里没有『将删』两个字」：那是中文字面量，换成 en 就失明。
 * 从模板切出固定前缀，等于问「屏幕上有没有出现这句话的任何一种填充形态」——
 * 只要产品换了文案，这里跟着换，不需要用例知道具体措辞。
 */
function hasLineWithPrefix(lines: string[], template: string): boolean {
  const prefix = template.split('{')[0]?.trimEnd() ?? '';
  return prefix !== '' && lines.some((l) => l.startsWith(prefix));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ccai-handoff-prune-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('headerValue：头部字段按结构取，不按行形态', () => {
  const text = [
    '# 交接单 — demo',
    '> 项目: C:\\dev\\demo',
    '> 会话: 20261115-120000-001',
    '> 退出原因: completed',
    '',
    '## ① 做到哪一步',
    // 正文里的同形文本：用**ASCII 哨兵**而不是中文句子——本文件的断言一律不绑中文字面量
    // （v5.4 候选 3），用一个一眼能 grep 的哨兵同样能证明「正文不被误吃」。
    '> 项目: BODY_ONLY_SENTINEL_NOT_HEADER',
    '',
  ].join('\n');

  it('首行 `# 标题` 之前/之后都能取到（历史坑：遇到非 `> ` 行就 break ⇒ 永远读不到）', () => {
    expect(headerValue(text, '项目')).toBe('C:\\dev\\demo');
    expect(headerValue(text, '会话')).toBe('20261115-120000-001');
  });

  it('**否定面**：正文里的同形文本不被误吃（边界是「第一个 `## ` 之前」）', () => {
    expect(headerValue(text, '项目')).not.toContain('BODY_ONLY_SENTINEL_NOT_HEADER');
  });

  it('`无` / 缺字段 ⇒ undefined', () => {
    expect(headerValue('> 会话: 无\n', '会话')).toBeUndefined();
    expect(headerValue('# 交接单\n\n## ① 做到哪一步\n无\n', '项目')).toBeUndefined();
  });
});

describe('classifyHandoffDir：两条判据（路径已不存在 + 无真实会话 id）', () => {
  const existsYes = (): boolean => true;
  const existsNo = (): boolean => false;
  /**
   * 会话文件状态全注入（**绝不落到默认实现**）。
   *
   * 默认实现走 `sessionFileState()` → `~/.concertoai/sessions/`，那会让用例结果取决于
   * 开发者机器上恰好有没有那个会话文件——「我这绿了」证明不了任何事。
   */
  const sessionExists = (): SessionFileState => 'exists';
  const sessionAbsent = (): SessionFileState => 'absent';
  const sessionUnknown = (): SessionFileState => 'unknown';

  it('路径不存在 + 无会话 ⇒ `prune`（临时目录回收后的测试产物，B4 的主体）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: true, project: 'C:\\tmp\\gone', sessionId: undefined },
        existsNo,
        sessionAbsent,
      ).verdict,
    ).toBe('prune');
  });

  it('**证据优先**：路径不存在但带真实会话 id **且文件已核验** ⇒ 保留（真话不会因为不方便就变成垃圾）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: true, project: 'C:\\tmp\\gone', sessionId: '20261115-120000-001' },
        existsNo,
        sessionExists,
      ).verdict,
    ).toBe('keep-real-session');
  });

  it('形状合法但会话文件**查无**（absent）+ 项目已不在 ⇒ `prune`（v5.4 候选 1 的核心：形状≠证据）', () => {
    const r = classifyHandoffDir(
      { handoffExists: true, project: 'C:\\tmp\\gone', sessionId: '20261115-120000-001' },
      existsNo,
      sessionAbsent,
    );
    expect(r.verdict).toBe('prune');
    // 判据要在文案里写出来：用户得能看懂「为什么这份明明有 id 也能删」。
    //
    // ⚠️ B 类（v5.4 候选 3，用户裁决「登记边界，本轮不改」）：`detail` 是
    // `classifyHandoffDir()` 里**硬编码的中文**，不走 i18n。所以这条断言是**唯一**
    // 允许绑中文字面量的地方——它守的是「判据写出来了」，不是「文案跟随语言」。
    // 改它要连 src 的 detail 生成逻辑一起搬到 `t().handoff.*`（含参数化），
    // 那属于另一件事；在那之前 en 用户看逐条清单会见到中英混排，这是**已知边界**。
    expect(r.detail).toContain('已不存在');
  });

  it('形状合法但会话文件**读不到**（unknown）⇒ `keep-unverified`，项目不在也照样保留', () => {
    const r = classifyHandoffDir(
      { handoffExists: true, project: 'C:\\tmp\\gone', sessionId: '20261115-120000-001' },
      existsNo,
      sessionUnknown,
    );
    expect(r.verdict).toBe('keep-unverified');
    // B 类边界（同上）：detail 硬编码中文，不走 i18n —— 本轮登记不改。
    expect(r.detail).toContain('无法核验');
  });

  it('形状合法 + absent + 项目**仍在** ⇒ 保留·项目在（路径判据仍然生效，不被会话判据吞掉）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: true, project: 'C:\\tmp\\alive', sessionId: '20261115-120000-001' },
        existsYes,
        sessionAbsent,
      ).verdict,
    ).toBe('keep-project-exists');
  });

  it('路径仍在 + 无会话 ⇒ 保留（用户下次还要进这个项目）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: true, project: 'C:\\tmp\\alive', sessionId: undefined },
        existsYes,
        sessionAbsent,
      ).verdict,
    ).toBe('keep-project-exists');
  });

  it('没有 handoff.md ⇒ `prune`（孤儿目录，没有任何证据可留）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: false, project: undefined, sessionId: undefined },
        existsYes,
        sessionAbsent,
      ).verdict,
    ).toBe('prune');
  });

  it('阶梯自证：三态 × 项目在/不在 ⇒ 四种结论各有落点（恒 prune / 恒 keep / 恒 unverified 三种废实现都过不去）', () => {
    const REAL = '20261115-120000-001';
    const base = { handoffExists: true, project: 'a', sessionId: REAL } as const;
    const verdicts = [
      classifyHandoffDir(base, existsNo, sessionExists).verdict, // keep-real-session
      classifyHandoffDir(base, existsNo, sessionUnknown).verdict, // keep-unverified
      classifyHandoffDir(base, existsNo, sessionAbsent).verdict, // prune
      classifyHandoffDir(base, existsYes, sessionAbsent).verdict, // keep-project-exists
    ];
    expect(verdicts).toEqual([
      'keep-real-session',
      'keep-unverified',
      'prune',
      'keep-project-exists',
    ]);
  });

  it('否定面：会话 id 形状**不合法**时，不查会话文件（没必要，也不许因此误留）', () => {
    let asked = 0;
    const r = classifyHandoffDir(
      { handoffExists: true, project: 'C:\\tmp\\gone', sessionId: 's-1' },
      existsNo,
      () => {
        asked += 1;
        return 'exists';
      },
    );
    expect(r.verdict).toBe('prune');
    expect(asked).toBe(0);
  });
});

describe('scanHandoffDirs / pruneHandoffs：真实文件系统上的行为', () => {
  /**
   * 会话文件状态注入（默认实现会读开发者真实 `~/.concertoai/sessions/`）：
   * 本组用例只关心「文件系统扫描 + 判定贯通」，会话这三态由上一个 describe 单独验。
   * 这里统一给 `exists`，让 `evidence-*` 走「已核验的证据」这条通道。
   */
  const allSessionsExist = (): SessionFileState => 'exists';

  beforeEach(() => {
    makeDir('gone-aaaaaaaaaaaa', { project: 'C:\\tmp\\gone-proj' });
    makeDir('alive-bbbbbbbbbbbb', { project: root }); // 用临时根当「仍存在的项目」
    makeDir('evidence-cccccccccccc', {
      project: 'C:\\tmp\\gone2',
      session: '20261115-120000-001',
    });
    makeDir('orphan-dddddddddddd', { noFile: true });
  });

  it('扫描把四条分到三类（读数能对上）', () => {
    const infos = scanHandoffDirs(root, undefined, allSessionsExist);
    const byName = new Map(infos.map((i) => [i.name, i.verdict]));
    expect(byName.get('gone-aaaaaaaaaaaa')).toBe('prune');
    expect(byName.get('alive-bbbbbbbbbbbb')).toBe('keep-project-exists');
    expect(byName.get('evidence-cccccccccccc')).toBe('keep-real-session');
    expect(byName.get('orphan-dddddddddddd')).toBe('prune');
  });

  it('**默认 dry-run**：`pruneHandoffs()` 一个都不删，只报候选（与 metrics 默认 off 同一取向）', () => {
    const result = pruneHandoffs({ root, sessionStateOf: allSessionsExist });
    expect(result.candidates.sort()).toEqual(['gone-aaaaaaaaaaaa', 'orphan-dddddddddddd']);
    expect(result.removed).toEqual([]);
    // 否定面：磁盘事实——目录必须还在
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(true);
    expect(existsSync(path.join(root, 'orphan-dddddddddddd'))).toBe(true);
  });

  it('`apply: true` 只删候选，保留项与证据都还在（并留一行 failed 通道）', () => {
    const result = pruneHandoffs({ root, apply: true, sessionStateOf: allSessionsExist });
    expect(result.removed.sort()).toEqual(['gone-aaaaaaaaaaaa', 'orphan-dddddddddddd']);
    expect(result.failed).toEqual([]);
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(false);
    expect(existsSync(path.join(root, 'orphan-dddddddddddd'))).toBe(false);
    expect(existsSync(path.join(root, 'alive-bbbbbbbbbbbb', 'handoff.md'))).toBe(true);
    expect(existsSync(path.join(root, 'evidence-cccccccccccc', 'handoff.md'))).toBe(true);
  });

  it('**三态贯通到磁盘层**：同一批目录，会话状态换一个值，可删集合跟着变', () => {
    // 与上一条同一起点：evidence-* 项目已不在，唯一变量就是「会话文件在不在」
    const asUnknown = pruneHandoffs({ root, sessionStateOf: () => 'unknown' });
    expect(asUnknown.candidates.sort()).toEqual(['gone-aaaaaaaaaaaa', 'orphan-dddddddddddd']);
    expect(existsSync(path.join(root, 'evidence-cccccccccccc', 'handoff.md'))).toBe(true);

    const asAbsent = pruneHandoffs({ root, sessionStateOf: () => 'absent' });
    // absent ⇒ 不构成证据 ⇒ 项目也不在 ⇒ 进入可清理（这正是本机 145 个的形态）
    expect(asAbsent.candidates.sort()).toEqual([
      'evidence-cccccccccccc',
      'gone-aaaaaaaaaaaa',
      'orphan-dddddddddddd',
    ]);

    const asExists = pruneHandoffs({ root, sessionStateOf: () => 'exists' });
    expect(asExists.candidates.sort()).toEqual(['gone-aaaaaaaaaaaa', 'orphan-dddddddddddd']);
  });

  it('幂等：删完再跑一次 ⇒ 候选为空、不报错（重复执行不会二次破坏）', () => {
    pruneHandoffs({ root, apply: true, sessionStateOf: allSessionsExist });
    const again = pruneHandoffs({ root, apply: true, sessionStateOf: allSessionsExist });
    expect(again.candidates).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it('根目录不存在 ⇒ 空列表，不抛错（首次运行 / 已清干净）', () => {
    expect(scanHandoffDirs(path.join(root, 'nope'), undefined, allSessionsExist)).toEqual([]);
    expect(
      pruneHandoffs({
        root: path.join(root, 'nope'),
        apply: true,
        sessionStateOf: allSessionsExist,
      }).candidates,
    ).toEqual([]);
  });
});

describe('runHandoffCommand：文案与退出码', () => {
  /** 业务判据（三态）已在别处验过；本组只看文案与退出码，故把 evidence 定为「已核验」。 */
  const sessionsExist = (): SessionFileState => 'exists';

  beforeEach(() => {
    makeDir('gone-aaaaaaaaaaaa', { project: 'C:\\tmp\\gone-proj' });
    makeDir('evidence-cccccccccccc', {
      project: 'C:\\tmp\\gone2',
      session: '20261115-120000-001',
    });
  });

  it('`list` 只打印不动盘，退出码 0', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({
      action: 'list',
      root,
      sessionStateOf: sessionsExist,
      log: (m) => lines.push(m),
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(true);
    /**
     * 文案断言一律**与产品同源**（v5.4 候选 3 A 类）：拿 `t().handoff.*` 的模板 + `fmt`
     * 拼出期望整行，再断言屏幕上**有这一行**。判据从「屏幕上出现某几个中文字」升级为
     * 「整行等于字典模板」——文案改了、占位符漏了、参数没填，都会红。
     */
    const dict = t().handoff;
    expect(lines).toContain(fmt(dict.title, { path: root, total: 2 }));
    expect(lines).toContain(
      fmt(dict.summary, {
        keepRealSession: 1,
        keepUnverified: 0,
        keepProjectExists: 0,
        prune: 1,
      }),
    );
    expect(lines).toContain(dict.listHint);
    // 证据类必须显式标出来：逐条清单那一行（detail 是 B 类硬编码中文，故只断标签部分）
    const evidenceLine = lines.find((l) => l.includes('evidence-cccccccccccc')) ?? '';
    expect(evidenceLine).toContain(dict.keepRealSession);
  });

  it('`prune` 不带 --yes ⇒ 打印「本次未删除任何东西」，盘上原样', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({
      action: 'prune',
      root,
      sessionStateOf: sessionsExist,
      log: (m) => lines.push(m),
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(true);
    const dict = t().handoff;
    // 整行等于字典模板：{count} 被填成真实候选数（1 个），不是「屏幕上出现了这几个字」
    expect(lines).toContain(fmt(dict.dryRun, { count: 1 }));
    expect(lines).toContain(dict.dryRunHint);
    // 否定面：dry-run **不许**念真删的两句话（那是 --yes 的活）
    expect(lines).not.toContain(fmt(dict.pruned, { count: 1 }));
    expect(hasLineWithPrefix(lines, dict.confirmYes)).toBe(false);
  });

  it('会话读不到（unknown）⇒ 屏幕上出现「保留·未核验」，且**不许**进可清理', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({
      action: 'prune',
      root,
      sessionStateOf: () => 'unknown',
      log: (m) => lines.push(m),
    });
    expect(code).toBe(0);
    const dict = t().handoff;
    /**
     * 整行与字典模板比较（A 类）：unknown ⇒ 摘要里「会话未核验 1」、可清理 0。
     * 注意 `keepRealSession` 这里应为 0——`sessionsExist` 注入器在本用例被替换成 `unknown`，
     * 所以这一行能同时钉住「未核验被算进未核验、**没被**算进已核验」。
     */
    expect(lines).toContain(
      fmt(dict.summary, {
        keepRealSession: 0,
        keepUnverified: 1,
        keepProjectExists: 0,
        prune: 1,
      }),
    );
    // 否定面：unknown 的目录绝不能被念成「可清理」
    const unverifiedLine = lines.find((l) => l.includes('evidence-cccccccccccc')) ?? '';
    expect(unverifiedLine).toContain(dict.keepUnverified);
    expect(unverifiedLine).not.toContain(dict.prune);
  });

  it('`prune --yes` ⇒ 真删，并报删除数量（且**先**念一遍摘要再删）', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({
      action: 'prune',
      root,
      yes: true,
      sessionStateOf: sessionsExist,
      log: (m) => lines.push(m),
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(false);
    const dict = t().handoff;
    // 整行比较：删除数量、以及「其中几个是会话文件查无」这个关键括号都在同一行里
    expect(lines).toContain(fmt(dict.pruned, { count: 1 }));
    expect(lines).toContain(
      fmt(dict.confirmYes, {
        count: 1,
        absentCount: 0,
        keepRealSession: 1,
        keepUnverified: 0,
        keepProjectExists: 0,
      }),
    );
    // --yes 是跳过审批，不是跳过摘要：摘要行必须出现在「已删除」之前
    const confirmIdx = lines.indexOf(
      fmt(dict.confirmYes, {
        count: 1,
        absentCount: 0,
        keepRealSession: 1,
        keepUnverified: 0,
        keepProjectExists: 0,
      }),
    );
    const prunedIdx = lines.indexOf(fmt(dict.pruned, { count: 1 }));
    expect(confirmIdx).toBeGreaterThanOrEqual(0);
    expect(confirmIdx).toBeLessThan(prunedIdx);
  });

  it('未知子命令 ⇒ 退出码 1 且给出支持列表', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({ action: 'nuke', root, log: (m) => lines.push(m) });
    expect(code).toBe(1);
    // 整行等于模板（A 类）：既钉「说了是哪个子命令」，也钉「给了 list / prune 两个支持项」
    expect(lines).toContain(fmt(t().handoff.unknownAction, { action: 'nuke' }));
  });

  it('空目录 ⇒ 一句话说明路径，退出码 0', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'ccai-handoff-empty-'));
    try {
      const lines: string[] = [];
      expect(runHandoffCommand({ action: 'list', root: empty, log: (m) => lines.push(m) })).toBe(0);
      // 整行等于模板：路径必须是**被填进模板**的（不是屏幕上随便出现了这个路径）
      expect(lines).toContain(fmt(t().handoff.empty, { path: empty }));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
