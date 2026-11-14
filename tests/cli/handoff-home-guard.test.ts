/**
 * 套件级守卫的**归因判据**用例（v5.3 A）。
 *
 * ## 为什么这条判据需要用例（而不是「代码看着对」）
 *
 * 守卫的动作是「sha 变了 ⇒ 红」。但实测发现 sha 会变有两种完全不同的成因：
 * ① 测试渲染真 `App` 写了真实 home（缺陷，必须红）；
 * ② 开发者自己的 chat 会话刷新了交接单（正常用法，判红就是假红——而假红比不判更糟，
 *    它教人怀疑「跑 verify 时不能开 chat」这种不存在的规矩）。
 * 于是判据里多了一个纯函数 `classifyChange`，它必须**两个方向都有牙**：
 * 只测「缺陷样本 ⇒ 红」时，一个恒返回 `test-written` 的废实现也全绿，而它会把 ② 全判红。
 *
 * 配变异探针验证有牙：把 `REAL_SESSION_ID` 改成 `/^$/`（永不匹配）⇒「外部会话不判红」两条红；
 * 把 `classifyChange` 改成恒 `test-written` ⇒ 同样两条红；把 `if (beforeSha === afterSha) return 'unchanged'`
 * 删掉 ⇒「sha 相同 ⇒ unchanged」一条红。改回后 8/8 复绿。
 *
 * 探针通电（第一层保证）：`REAL_SESSION_ID` 必须真的对**本项目真实的会话 id 形状**匹配——
 * 用一个从 `SessionStore` 同款格式串出来的真实样本证明，而不是只喂我拼的手写串。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SessionStore } from '../../src/store/session';
import { classifyChange, sessionIdOf } from '../handoff-home-guard.global';

/**
 * **探针通电**：这个 id 不是手写常量，而是**真实生成器**产出的
 * （同一个 `newSessionId()`，经 `SessionStore.create` 走完整创建路径）。
 * 只喂手写串的话，「判据认不认真实 id」根本没被验证——我拼的串恰好符合我的正则，那是同义反复。
 */
const probeDir = mkdtempSync(path.join(os.tmpdir(), 'concertoai-guard-id-'));
const REAL_ID = await new SessionStore(probeDir).create([]);

afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

/** 交接单（只保留头部几行，与 `buildHandoff` 产出的结构一致）。 */
function handoff(sessionId: string | undefined): string {
  return [
    '# 交接单 — concertoai',
    '> 项目: F:\\developer\\2026\\concertoai',
    `> 会话: ${sessionId ?? '无'}`,
    '> 写入时间: 2026-11-14T17:44:21.862Z',
    '> 退出原因: max-turns',
    '',
    '## ① 做到哪一步',
    '占了 3 个文件',
    '',
  ].join('\n');
}

describe('sessionIdOf：从交接单头部取 `> 会话:`', () => {
  it('真实生成器产出的会话 id ⇒ 原样取出（探针通电：证明判据读得到这一行）', () => {
    expect(REAL_ID).toMatch(/^\d{8}-\d{6}-\d{3}$/); // 先证样本本身确实是那个形状
    expect(sessionIdOf(handoff(REAL_ID))).toBe(REAL_ID);
  });

  it('`无` / 缺失 / 空串 ⇒ undefined（测试写的交接单就长这样）', () => {
    expect(sessionIdOf(handoff(undefined))).toBeUndefined();
    expect(sessionIdOf('# 交接单\n\n没有头部\n')).toBeUndefined();
    expect(sessionIdOf('> 会话:   \n')).toBeUndefined();
  });
});

describe('classifyChange：谁改了真实 home 的交接单', () => {
  it('sha 相同 ⇒ `unchanged`（负例面：什么都没发生不许被判成任何写入）', () => {
    expect(classifyChange('abc', 'abc', handoff(REAL_ID))).toBe('unchanged');
  });

  it('变了 + 新内容是真实会话 id ⇒ `external-session`（**不许判红**）', () => {
    expect(classifyChange('abc', 'def', handoff(REAL_ID))).toBe('external-session');
  });

  it('变了 + 新内容 `> 会话: 无` ⇒ `test-written`（真 App 用例没传 sessionId 就长这样）', () => {
    expect(classifyChange('abc', 'def', handoff(undefined))).toBe('test-written');
  });

  it('变了 + 假会话 id（`s-1` / `s-3`）⇒ `test-written`', () => {
    expect(classifyChange('abc', 'def', handoff('s-1'))).toBe('test-written');
    expect(classifyChange('abc', 'def', handoff('s-3'))).toBe('test-written');
  });

  it('变了 + 文件被删/读不到 ⇒ `test-written`（拿不到证据时按缺陷处理，不按无罪推定）', () => {
    expect(classifyChange('abc', 'def', undefined)).toBe('test-written');
  });

  it('阶梯自证：同一份「变了」的输入，四个成因各给出不同结论（废实现过不去）', () => {
    const verdicts = [
      classifyChange('a', 'b', handoff(REAL_ID)),
      classifyChange('a', 'b', handoff(undefined)),
      classifyChange('a', 'b', handoff('s-1')),
      classifyChange('a', 'b', undefined),
    ];
    // 「恒 external-session」与「恒 test-written」两种废实现都会让下面这两条之一红
    expect(verdicts.filter((v) => v === 'external-session')).toHaveLength(1);
    expect(verdicts.filter((v) => v === 'test-written')).toHaveLength(3);
  });
});
