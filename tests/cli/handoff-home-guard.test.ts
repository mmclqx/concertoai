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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SessionStore } from '../../src/store/session';
import {
  classifyAddedDirs,
  classifyChange,
  classifyNewDir,
  sessionIdOf,
} from '../handoff-home-guard.global';

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

/**
 * v5.3 B4：**新增目录名单**的判决（`classifyAddedDirs`）+ 它的**接线**。
 *
 * 为什么要两条分开写：纯函数用例只能证明「算得对」，证明不了「teardown 真的调了它」。
 * A 轮的 M-C 探针就是这种形态——纯函数 8/8 全绿，而调用点压根没用归因。
 * 故这里额外读 `handoff-home-guard.global.ts` 的源码断言调用关系（源码护栏）。
 */
describe('classifyAddedDirs：新增名单 ⇒ 放行 / 判红', () => {
  const existsReal = (id: string): boolean => id === '20261115-120000-001';

  it('混合名单：真实会话放行、其余判红（两条通道各自完整，不互相吞）', () => {
    const byName = new Map<string, string | undefined>([
      ['ok-aaaaaaaaaaaa', '20261115-120000-001'],
      ['fake-bbbbbbbbbbbb', '20261115-120449-301'], // 形状对但在真实 sessions/ 里查无此文件
      ['none-cccccccccccc', undefined],
    ]);
    const { offenders, allowed } = classifyAddedDirs(
      ['ok-aaaaaaaaaaaa', 'fake-bbbbbbbbbbbb', 'none-cccccccccccc'],
      (n) => byName.get(n),
      existsReal,
    );
    expect(allowed).toEqual(['ok-aaaaaaaaaaaa']);
    expect(offenders).toEqual(['fake-bbbbbbbbbbbb', 'none-cccccccccccc']);
  });

  it('空名单 ⇒ 两边都空（负例面：不许「没有新增也喊红」）', () => {
    const { offenders, allowed } = classifyAddedDirs([], () => undefined, existsReal);
    expect(offenders).toEqual([]);
    expect(allowed).toEqual([]);
  });

  it('全是测试写的 ⇒ 全判红（B4 缺陷形态：43 个目录一个都不该留着）', () => {
    const names = ['a-111111111111', 'b-222222222222', 'c-333333333333'];
    const result = classifyAddedDirs(names, () => undefined, existsReal);
    expect(result.offenders).toEqual(names);
    expect(result.allowed).toEqual([]);
  });
});

describe('接线护栏：teardown 真的用了归因（不是只有纯函数好看）', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'tests', 'handoff-home-guard.global.ts'),
    'utf8',
  );
  /** 剥掉注释再匹配——否则会咬到说明「为什么不内联」的那几句注释（A 轮护栏咬过解释者）。 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('正例自证：源码里确实有 teardown、有 classifyAddedDirs 的调用', () => {
    expect(code).toContain('export function teardown');
    expect(code).toContain('classifyAddedDirs(');
  });

  it('teardown 内出现 `classifyAddedDirs(` 且结果被用于判红（`offenders`）', () => {
    const at = code.indexOf('export function teardown');
    const body = code.slice(at);
    expect(body, 'teardown 必须调用纯函数归因，而不是自己内联一套').toContain('classifyAddedDirs(');
    expect(body, 'offenders 必须参与判红').toContain('offenders.length > 0');
    expect(body, '判红必须钉退出码（teardown 里 throw 不改退出码，A 轮实测）').toContain(
      'process.exitCode = 1',
    );
  });
});

/**
 * v5.3 B4：**新增目录**的归因（从「守一个文件」扩到「守根目录」）。
 *
 * 这里的判据比上面那条更严一格：光「会话 id 形状对」**不够**，还必须该 id 在真实会话目录
 * 里真有 `.jsonl`。原因是实测出来的假阴性——`tests/ui/auto-low-approval.test.tsx` 用真
 * `SessionStore` 建会话，写出的 id 形状完全合法（`20261115-120449-301`），而真实
 * `~/.concertoai/sessions/` 下没有这个文件。只查形状 ⇒ 这 5 个目录被免罪。
 *
 * 配变异探针 M3（归因退回「只看形状」）⇒ 第 2 条与阶梯自证红。
 */
describe('classifyNewDir：新增的交接单目录是谁造的', () => {
  it('形状对 **且** 真实会话文件存在 ⇒ `external-session`（边开 chat 边跑 verify，不判红）', () => {
    expect(classifyNewDir({ name: 'proj-abc123', sessionId: REAL_ID }, () => true)).toBe(
      'external-session',
    );
  });

  it('形状对但**查无此会话文件** ⇒ `test-written`（B4 实测的假阴性，必须红）', () => {
    // 这条样本就是实测抓到的那个：形状合法，但真实 sessions/ 里没有它
    expect(
      classifyNewDir(
        { name: 'concertoai-v51-0ND57Z-493f0c46a2fa', sessionId: '20261115-120449-301' },
        () => false,
      ),
    ).toBe('test-written');
  });

  it('没有会话 id（测试用真 App 且没传 sessionId）⇒ `test-written`', () => {
    expect(classifyNewDir({ name: 'proj-abc123', sessionId: undefined }, () => true)).toBe(
      'test-written',
    );
  });

  it('假 id（`s-1`）⇒ `test-written`，即使把 exists 恒设为 true 也不放行', () => {
    // 「恒 true 的 exists」是最容易被凑出的假绿：形状不合法时 exists 根本不该被问
    let asked = 0;
    const exists = (): boolean => {
      asked += 1;
      return true;
    };
    expect(classifyNewDir({ name: 'proj-abc123', sessionId: 's-1' }, exists)).toBe('test-written');
    expect(asked, '形状不合法时不该去查会话文件（省 IO，也避免把结论建立在无关证据上）').toBe(0);
  });

  it('阶梯自证：四种输入 ⇒ 恰好 1 个 external（恒 external / 恒 test-written 两种废实现都过不去）', () => {
    const realExists = (id: string): boolean => id === REAL_ID;
    const verdicts = [
      classifyNewDir({ name: 'a', sessionId: REAL_ID }, realExists),
      classifyNewDir({ name: 'b', sessionId: '20261115-120449-301' }, realExists),
      classifyNewDir({ name: 'c', sessionId: undefined }, realExists),
      classifyNewDir({ name: 'd', sessionId: 's-1' }, realExists),
    ];
    expect(verdicts.filter((v) => v === 'external-session')).toHaveLength(1);
    expect(verdicts.filter((v) => v === 'test-written')).toHaveLength(3);
  });
});
