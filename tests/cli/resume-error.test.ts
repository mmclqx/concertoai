/**
 * v5.2 边缘路径：`chat -r <id>` 读不到会话时**说人话**（此前直接甩 Node 堆栈）。
 *
 * ## 这些用例证明的是什么（用户视角）
 *
 * `-r` 的 id 形如 `20261113-024243-266`，手抄必错。实测（隔离 HOME，真 TTY）：
 *
 * ```
 * concertoai chat -r 20200101-000000-000
 * [ConcertoAI] 未处理的 Promise 拒绝，详情见 …\crash.log
 * Error: ENOENT: no such file or directory, open '…\sessions\20200101-000000-000.jsonl'
 *     at async open (node:internal/fs/promises:639:25)
 * ```
 *
 * 退出码是对的，但屏幕上是一段堆栈。`describeResumeFailure` 把「三种失败」翻译成人话。
 *
 * ## 为什么必须有「unreadable ≠ not-found」这一条
 *
 * 把「读失败的所有原因」压成一句「没有这个会话」，就是 `doctor` N1 那个 bug 的同款错误
 * （`catch` 推断存在性）。所以这里用一条**否定面**钉住：权限/磁盘错误时**不得**说「没有这个会话」。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyResumeError,
  describeResumeFailure,
  MAX_RECENT_SESSIONS,
} from '../../src/cli/resume-error';
import { setLocale } from '../../src/i18n';
import type { SessionSummary } from '../../src/store/session';

function summary(id: string, count = 3): SessionSummary {
  return { id, createdAt: Date.now(), messageCount: count, firstUserMessage: null };
}

function enoent(path = 'x.jsonl'): NodeJS.ErrnoException {
  const err = new Error(
    `ENOENT: no such file or directory, open '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function eacces(): NodeJS.ErrnoException {
  const err = new Error(
    'EACCES: permission denied, open x.jsonl\n    at async Object.open',
  ) as NodeJS.ErrnoException;
  err.code = 'EACCES';
  return err;
}

afterEach(() => {
  // 进程级全局状态复位（AGENTS：在测试进程内调用过 setLocale 必须复位，不指望用例顺序）
  setLocale('zh');
});

describe('classifyResumeError：三种失败分开归类', () => {
  it('id 带路径分隔符 ⇒ invalid-id（在读盘之前就判掉，防路径穿越）', () => {
    expect(classifyResumeError('../etc/passwd', enoent())).toBe('invalid-id');
    expect(classifyResumeError('a/b', enoent())).toBe('invalid-id');
    expect(classifyResumeError('', enoent())).toBe('invalid-id');
  });

  it('合法 id + ENOENT ⇒ not-found', () => {
    expect(classifyResumeError('20261113-024243-266', enoent())).toBe('not-found');
  });

  it('合法 id + 其他错误 ⇒ unreadable（**不是** not-found）', () => {
    expect(classifyResumeError('20261113-024243-266', eacces())).toBe('unreadable');
    expect(classifyResumeError('20261113-024243-266', new Error('随便什么错'))).toBe('unreadable');
  });
});

describe('describeResumeFailure：用户看到的话', () => {
  it('不存在的会话 ⇒ 说「没有这个会话」+ 列出最近几个真实 id（帮用户认出正确那个）', () => {
    const lines = describeResumeFailure({
      id: '20200101-000000-000',
      error: enoent(),
      recent: [summary('20261113-024243-266', 12), summary('20261112-120000-001', 5)],
    });
    expect(lines[0]).toContain('没有这个会话');
    expect(lines[0]).toContain('20200101-000000-000');
    expect(lines.join('\n')).toContain('20261113-024243-266');
    expect(lines.join('\n')).toContain('12');
  });

  it('一个会话都没有 ⇒ 说「暂无历史会话」（与「记错 id」区分开，别让用户以为记录丢了）', () => {
    const lines = describeResumeFailure({ id: 'nope', error: enoent(), recent: [] });
    expect(lines[0]).toContain('没有这个会话');
    expect(lines.join('\n')).toContain('暂无历史会话');
  });

  it(`最多列 ${MAX_RECENT_SESSIONS} 个会话（启动期不该刷屏把错误行挤出屏幕）`, () => {
    const recent = Array.from({ length: 12 }, (_, i) => summary(`2026111${i % 10}-000000-00${i}`));
    const lines = describeResumeFailure({ id: 'nope', error: enoent(), recent });
    const idLines = lines.filter((l) => /^ {2}\d{8}-/.test(l));
    expect(idLines).toHaveLength(MAX_RECENT_SESSIONS);
  });

  it('三处失败都给出下一步（`chat -l`），不留死胡同', () => {
    for (const [id, error] of [
      ['../x', enoent()],
      ['20261113-024243-266', enoent()],
      ['20261113-024243-266', eacces()],
    ] as const) {
      const text = describeResumeFailure({ id, error, recent: [] }).join('\n');
      expect(text).toContain('chat -l');
    }
  });

  it('id 不合法 ⇒ 说清允许的字符集，且**不**谎称「没有这个会话」', () => {
    const text = describeResumeFailure({ id: '../secret', error: enoent(), recent: [] }).join('\n');
    expect(text).toContain('会话 id 不合法');
    expect(text).not.toContain('没有这个会话');
  });

  it('★ 否定面：读失败原因不是「不存在」（EACCES）⇒ **不得**说「没有这个会话」', () => {
    // 改坏方式：让 classifyResumeError 无条件返回 'not-found' ⇒ 这条红
    const text = describeResumeFailure({
      id: '20261113-024243-266',
      error: eacces(),
      recent: [],
    }).join('\n');
    expect(text).toContain('读取会话失败');
    expect(text).not.toContain('没有这个会话');
  });

  it('★ 不把堆栈甩给用户：多行错误只取首行并截断', () => {
    const text = describeResumeFailure({
      id: '20261113-024243-266',
      error: eacces(),
      recent: [],
    }).join('\n');
    expect(text).not.toContain('at async');
    expect(text.split('\n').every((l) => l.length <= 200)).toBe(true);
  });

  it('en 侧文案无 CJK（locale 切换后仍成立）', () => {
    setLocale('en');
    const text = describeResumeFailure({
      id: 'nope',
      error: enoent(),
      recent: [summary('20261113-024243-266')],
    }).join('\n');
    expect(text).not.toMatch(/[\u4e00-\u9fa5]/);
    expect(text).toContain('No such session');
  });
});
