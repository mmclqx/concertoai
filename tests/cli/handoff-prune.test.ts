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
    '> 项目: 这是正文里的同形文本，不该被当成头部',
    '',
  ].join('\n');

  it('首行 `# 标题` 之前/之后都能取到（历史坑：遇到非 `> ` 行就 break ⇒ 永远读不到）', () => {
    expect(headerValue(text, '项目')).toBe('C:\\dev\\demo');
    expect(headerValue(text, '会话')).toBe('20261115-120000-001');
  });

  it('**否定面**：正文里的同形文本不被误吃（边界是「第一个 `## ` 之前」）', () => {
    expect(headerValue(text, '项目')).not.toContain('正文里的同形文本');
  });

  it('`无` / 缺字段 ⇒ undefined', () => {
    expect(headerValue('> 会话: 无\n', '会话')).toBeUndefined();
    expect(headerValue('# 交接单\n\n## ① 做到哪一步\n无\n', '项目')).toBeUndefined();
  });
});

describe('classifyHandoffDir：两条判据（路径已不存在 + 无真实会话 id）', () => {
  const existsYes = (): boolean => true;
  const existsNo = (): boolean => false;

  it('路径不存在 + 无会话 ⇒ `prune`（临时目录回收后的测试产物，B4 的主体）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: true, project: 'C:\\tmp\\gone', sessionId: undefined },
        existsNo,
      ).verdict,
    ).toBe('prune');
  });

  it('**证据优先**：路径不存在但带真实会话 id ⇒ 保留（真话不会因为不方便就变成垃圾）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: true, project: 'C:\\tmp\\gone', sessionId: '20261115-120000-001' },
        existsNo,
      ).verdict,
    ).toBe('keep-real-session');
  });

  it('路径仍在 + 无会话 ⇒ 保留（用户下次还要进这个项目）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: true, project: 'C:\\tmp\\alive', sessionId: undefined },
        existsYes,
      ).verdict,
    ).toBe('keep-project-exists');
  });

  it('没有 handoff.md ⇒ `prune`（孤儿目录，没有任何证据可留）', () => {
    expect(
      classifyHandoffDir(
        { handoffExists: false, project: undefined, sessionId: undefined },
        existsYes,
      ).verdict,
    ).toBe('prune');
  });

  it('阶梯自证：四种输入 ⇒ 三种结论各有落点（恒 prune / 恒 keep 两种废实现都过不去）', () => {
    const verdicts = [
      classifyHandoffDir(
        { handoffExists: true, project: 'a', sessionId: '20261115-120000-001' },
        existsNo,
      ).verdict,
      classifyHandoffDir({ handoffExists: true, project: 'a', sessionId: undefined }, existsYes)
        .verdict,
      classifyHandoffDir({ handoffExists: true, project: 'a', sessionId: undefined }, existsNo)
        .verdict,
      classifyHandoffDir(
        { handoffExists: false, project: undefined, sessionId: undefined },
        existsYes,
      ).verdict,
    ];
    expect(verdicts.filter((v) => v === 'keep-real-session')).toHaveLength(1);
    expect(verdicts.filter((v) => v === 'keep-project-exists')).toHaveLength(1);
    expect(verdicts.filter((v) => v === 'prune')).toHaveLength(2);
  });
});

describe('scanHandoffDirs / pruneHandoffs：真实文件系统上的行为', () => {
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
    const infos = scanHandoffDirs(root);
    const byName = new Map(infos.map((i) => [i.name, i.verdict]));
    expect(byName.get('gone-aaaaaaaaaaaa')).toBe('prune');
    expect(byName.get('alive-bbbbbbbbbbbb')).toBe('keep-project-exists');
    expect(byName.get('evidence-cccccccccccc')).toBe('keep-real-session');
    expect(byName.get('orphan-dddddddddddd')).toBe('prune');
  });

  it('**默认 dry-run**：`pruneHandoffs()` 一个都不删，只报候选（与 metrics 默认 off 同一取向）', () => {
    const result = pruneHandoffs({ root });
    expect(result.candidates.sort()).toEqual(['gone-aaaaaaaaaaaa', 'orphan-dddddddddddd']);
    expect(result.removed).toEqual([]);
    // 否定面：磁盘事实——目录必须还在
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(true);
    expect(existsSync(path.join(root, 'orphan-dddddddddddd'))).toBe(true);
  });

  it('`apply: true` 只删候选，保留项与证据都还在（并留一行 failed 通道）', () => {
    const result = pruneHandoffs({ root, apply: true });
    expect(result.removed.sort()).toEqual(['gone-aaaaaaaaaaaa', 'orphan-dddddddddddd']);
    expect(result.failed).toEqual([]);
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(false);
    expect(existsSync(path.join(root, 'orphan-dddddddddddd'))).toBe(false);
    expect(existsSync(path.join(root, 'alive-bbbbbbbbbbbb', 'handoff.md'))).toBe(true);
    expect(existsSync(path.join(root, 'evidence-cccccccccccc', 'handoff.md'))).toBe(true);
  });

  it('幂等：删完再跑一次 ⇒ 候选为空、不报错（重复执行不会二次破坏）', () => {
    pruneHandoffs({ root, apply: true });
    const again = pruneHandoffs({ root, apply: true });
    expect(again.candidates).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it('根目录不存在 ⇒ 空列表，不抛错（首次运行 / 已清干净）', () => {
    expect(scanHandoffDirs(path.join(root, 'nope'))).toEqual([]);
    expect(pruneHandoffs({ root: path.join(root, 'nope'), apply: true }).candidates).toEqual([]);
  });
});

describe('runHandoffCommand：文案与退出码', () => {
  beforeEach(() => {
    makeDir('gone-aaaaaaaaaaaa', { project: 'C:\\tmp\\gone-proj' });
    makeDir('evidence-cccccccccccc', {
      project: 'C:\\tmp\\gone2',
      session: '20261115-120000-001',
    });
  });

  it('`list` 只打印不动盘，退出码 0', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({ action: 'list', root, log: (m) => lines.push(m) });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('可清理');
    expect(text).toContain('保留·证据'); // 证据类必须显式标出来
  });

  it('`prune` 不带 --yes ⇒ 打印「本次未删除任何东西」，盘上原样', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({ action: 'prune', root, log: (m) => lines.push(m) });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(true);
    expect(lines.join('\n')).toContain('未删除');
  });

  it('`prune --yes` ⇒ 真删，并报删除数量', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({ action: 'prune', root, yes: true, log: (m) => lines.push(m) });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, 'gone-aaaaaaaaaaaa'))).toBe(false);
    expect(lines.join('\n')).toContain('已删除');
  });

  it('未知子命令 ⇒ 退出码 1 且给出支持列表', () => {
    const lines: string[] = [];
    const code = runHandoffCommand({ action: 'nuke', root, log: (m) => lines.push(m) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('list / prune');
  });

  it('空目录 ⇒ 一句话说明路径，退出码 0', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'ccai-handoff-empty-'));
    try {
      const lines: string[] = [];
      expect(runHandoffCommand({ action: 'list', root: empty, log: (m) => lines.push(m) })).toBe(0);
      expect(lines.join('\n')).toContain(empty);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
