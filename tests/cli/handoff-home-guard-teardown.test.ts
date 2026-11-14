/**
 * 套件级守卫的**接线**用例（v5.3 A）。
 *
 * ## 为什么有了 `classifyChange` 的用例还要这一条
 *
 * `tests/cli/handoff-home-guard.test.ts` 只测纯函数——变异探针 M-C（把 `teardown` 里的
 * `classifyChange(...)` 换回 `after === before ? 'unchanged' : 'test-written'`，即**归因没接上**）
 * 实测 **8/8 仍然全绿**。纯函数对了，但调用点没用它 ⇒ 一行都没红。
 * 这正是「测了实现、没测接线」，和 v5.3 N4 那个「写得完美但读不回来」同族。
 *
 * 所以这里**直接调 `setup()` / `teardown()`**（就是 vitest 真正调的那两个导出），
 * 把 cwd 切到一个一次性项目目录（落点仍在真实 home 下的 `<handoffs>/<tmp 项目 key>/`，
 * 但那是本用例自己的目录，与仓库那份无关），然后分别制造两种改动：
 *
 * - 测试写的（`> 会话: 无`）⇒ `teardown()` **必须抛错**且把 `process.exitCode` 钉成 1；
 * - 外部会话写的（真实会话 id）⇒ `teardown()` **必须不抛**（判红就是假红）。
 *
 * 每条都配「没改就不抛」的对照，否则「抛了」可能只是 `teardown` 恒抛。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handoffPath } from '../../src/cli/handoff';
import { SessionStore } from '../../src/store/session';
import { setup, teardown } from '../handoff-home-guard.global';

let tmpHome: string;
let tmpProj: string;
let originalCwd: string;
// `process.exitCode` 的类型是 `string | number | null | undefined`（Node 允许字符串）
let originalExitCode: string | number | null | undefined;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

/** 交接单正文（结构同 `buildHandoff`，只保留判定要用的头部）。 */
const handoffText = (session: string): string =>
  [
    '# 交接单 — proj',
    `> 项目: ${path.resolve(tmpProj)}`,
    `> 会话: ${session}`,
    '> 写入原因: completed',
    '',
    '## ① 做到哪一步',
    '动了 a.ts',
    '',
  ].join('\n');

beforeEach(() => {
  originalCwd = process.cwd();
  originalExitCode = process.exitCode;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;

  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'concertoai-guard-teardown-'));
  tmpProj = path.join(tmpHome, 'proj');
  mkdirSync(tmpProj, { recursive: true });
  // 落点在 `os.homedir()` 下 ⇒ 家目录也要钉，否则这一跑就是往开发者真实 home 里写
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.chdir(tmpProj);
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('teardown 接线：接线真的用了归因结论', () => {
  it('对照：什么都没改 ⇒ 不抛、不动退出码（证明「抛」不是恒抛）', () => {
    setup();
    expect(() => teardown()).not.toThrow();
    expect(process.exitCode).toBeUndefined();
  });

  it('测试写的（`> 会话: 无`）⇒ 抛错 + exitCode=1（CI 真的会红）', () => {
    setup();
    const file = handoffPath(tmpProj);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, handoffText('无'), 'utf8');

    expect(() => teardown()).toThrow(/测试套件改动了开发者真实 home 的交接单/);
    expect(process.exitCode).toBe(1);
  });

  it('外部会话写的（真实会话 id）⇒ 不抛、不动退出码（边开 chat 边跑 verify 不该假红）', async () => {
    const realId = await new SessionStore(path.join(tmpHome, 'sessions')).create([]);
    setup();
    const file = handoffPath(tmpProj);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, handoffText(realId), 'utf8');

    expect(() => teardown()).not.toThrow();
    expect(process.exitCode).toBeUndefined();
  });
});
