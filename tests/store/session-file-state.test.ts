/**
 * `sessionFileState()` —— 三态事实源（v5.4 候选 1）。
 *
 * ## 这一层守什么
 *
 * 它的结论直接决定 `handoff prune` **删不删**用户磁盘上的交接单。所以每条断言都对准
 * 一个具体的误删方式：
 * - 把 `unknown` 说成 `absent` ⇒ 权限/IO 错时把「唯一证据」当垃圾删掉（**不可逆**）；
 * - 把 `absent` 说成 `exists` ⇒ 永远清不掉该清的（恶心但不致命）；
 * - 用 `existsSync` 实现 ⇒ 上面两种必然同时发生（它把错误吞成 false）。
 *
 * ## 「unknown」怎么确定性造出来（不靠 EACCES）
 *
 * 路径上的某一级是**普通文件**时：`statSync` 抛 ENOENT/ENOTDIR、`existsSync` 静默返回 false。
 * 本机（Windows Node 22）实测：`existsSync(文件/a)` = false，`statSync(文件/a)` 抛 ENOENT，
 * `readdirSync(文件)` 抛 ENOTDIR。⇒ 把「会话根」指到一个普通文件即可稳定造出 unknown。
 * **如实标注**：真实权限错误（EACCES）在 Windows 上仍造不出来（AGENTS 已知边界 B2），
 * 本文件测的是「按错误码分类」这条分支，不是真实 EACCES 的端到端。
 *
 * 全部在 `mkdtemp` 临时根里跑，不碰真实 home。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isRealSessionIdShape, sessionFileState } from '../../src/store/session';

let root: string;

/** 与 `newSessionId()` 同形状（定长 8-6-3）——用固定值，避免用例依赖当前时间。 */
const REAL_ID = '20261115-133135-309';

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ccai-session-state-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sessionFileState：三态各自有落点', () => {
  it('`exists`：`<root>/<id>.jsonl` 真的在（正例自证：判据读得到真实文件）', () => {
    writeFileSync(path.join(root, `${REAL_ID}.jsonl`), '{}\n', 'utf8');
    expect(sessionFileState(REAL_ID, root)).toBe('exists');
  });

  it('`exists`：项目隔离布局 `<root>/<projectKey>/<id>.jsonl` 也算（两级兼容）', () => {
    mkdirSync(path.join(root, 'concertoai'), { recursive: true });
    writeFileSync(path.join(root, 'concertoai', `${REAL_ID}.jsonl`), '{}\n', 'utf8');
    expect(sessionFileState(REAL_ID, root)).toBe('exists');
  });

  it('`absent`：根在、目录里确实没有这个 id（查得到 ⇒ 可以清）', () => {
    writeFileSync(path.join(root, `${REAL_ID}.jsonl`), '{}\n', 'utf8');
    // 同目录下有**别的**会话，只缺这一个 ⇒ 走完整个扫描才敢说 absent
    expect(sessionFileState('20200101-000000-000', root)).toBe('absent');
  });

  it('`absent`：根目录本身不存在（首次运行 / 用户清过 sessions）', () => {
    expect(sessionFileState(REAL_ID, path.join(root, 'not-there'))).toBe('absent');
  });

  it('`unknown`：会话根是**普通文件**（读不到 ⇒ 必须保留，绝不能说 absent）', () => {
    const notADir = path.join(root, 'sessions-is-a-file');
    writeFileSync(notADir, 'x', 'utf8');
    // 同一事实两种读法：existsSync 静默 false（分不出来），本实现必须给 unknown
    expect(sessionFileState(REAL_ID, notADir)).toBe('unknown');
  });

  it('阶梯自证：三种输入 ⇒ 三个互不相同的答案（恒 exists / 恒 absent / 恒 unknown 三种废实现都过不去）', () => {
    const existsRoot = mkdtempSync(path.join(os.tmpdir(), 'ccai-ladder-'));
    try {
      writeFileSync(path.join(existsRoot, `${REAL_ID}.jsonl`), '{}\n', 'utf8');
      const notADir = path.join(root, 'file-root');
      writeFileSync(notADir, 'x', 'utf8');

      const answers = [
        sessionFileState(REAL_ID, existsRoot), // exists
        sessionFileState(REAL_ID, root), // absent（root 是空目录）
        sessionFileState(REAL_ID, notADir), // unknown
      ];
      expect(answers).toEqual(['exists', 'absent', 'unknown']);
      // 三个答案必须互不相同 —— 恒值废实现会在这里塌成同一个
      expect(new Set(answers).size).toBe(3);
    } finally {
      rmSync(existsRoot, { recursive: true, force: true });
    }
  });

  it('否定面：`unknown` 不许被当成 `absent`（这条是「删证据」的机械判据）', () => {
    const notADir = path.join(root, 'file-root-2');
    writeFileSync(notADir, 'x', 'utf8');
    const state = sessionFileState(REAL_ID, notADir);
    expect(state).not.toBe('absent');
    expect(state).toBe('unknown');
  });

  it('形状判据与状态判据互不替代：形状合法不代表文件在', () => {
    expect(isRealSessionIdShape(REAL_ID)).toBe(true);
    expect(sessionFileState(REAL_ID, root)).toBe('absent');
  });
});
