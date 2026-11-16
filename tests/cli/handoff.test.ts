/**
 * 交接单四栏（v5.3 N4，任务书 T2.1 / T2.4）。
 *
 * ## 这一层守的是什么
 *
 * `buildHandoff` 是纯函数（不调模型、不读时钟、不编内容）。它是「上次做到哪」的
 * **唯一来源**，所以错的代价是：下次进来照着一条假信息干活。故每条断言都对准
 * 一个具体的说谎方式：
 * - 四栏缺一栏（用户少一条线索）；
 * - ④ 四种原因文案相同（分不清「我自己退的」还是「它出事了」）；
 * - ② 把没返回结果的命令写成 ✅（编内容）；
 * - ② 被 20 条上限截掉失败项，而 ③ 还说「继续上次任务」（静默的谎）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHandoff,
  consumeHandoff,
  type ExitReason,
  exitReasonText,
  finalizeActiveSession,
  finalizeSession,
  handoffPath,
  installHandoffExitHook,
  MAX_ACCEPTANCE_LINES,
  MAX_INJECT_CHARS,
  readHandoff,
  resetHandoffState,
  sessionHasToolCalls,
  setActiveSession,
  writeHandoffAtProcessExit,
} from '../../src/cli/handoff';
import { formatToolFailure, formatToolResult, isToolErrorContent } from '../../src/loop/messages';
import type { ChatMessage, ToolCall } from '../../src/loop/types';

let home: string;
let cwd: string;

const FIXED_NOW = new Date('2026-11-14T12:00:00.000Z');

/** 造一条 assistant 工具调用消息。 */
const call = (id: string, name: string, args: Record<string, unknown>): ChatMessage => ({
  role: 'assistant',
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) } satisfies ToolCall],
});

/** 造一条工具回填消息。 */
const result = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  content,
  toolCallId: id,
});

/** 一次成功的 `run_command` 往返。 */
const okCommand = (id: string, command: string): ChatMessage[] => [
  call(id, 'run_command', { command }),
  result(id, JSON.stringify({ stdout: 'ok', code: 0 })),
];

/** 一次失败的 `run_command` 往返。 */
const failCommand = (id: string, command: string, error = 'exit 1'): ChatMessage[] => [
  call(id, 'run_command', { command }),
  result(id, formatToolFailure('run_command', error)),
];

/** 一次成功的 `edit_file` 往返。 */
const editFile = (id: string, file: string): ChatMessage[] => [
  call(id, 'edit_file', { path: file, old_string: 'a', new_string: 'b' }),
  result(id, JSON.stringify({ ok: true })),
];

/** 取某一栏的正文（到下一个 `## ` 为止）。 */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `找不到小节 ${heading}`).toBeGreaterThan(-1);
  const rest = text.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

const REASONS: ExitReason[] = [
  { kind: 'completed' },
  { kind: 'max-turns', used: 50, cap: 50 },
  { kind: 'interrupted' },
  { kind: 'error', message: 'ENOENT: no such file' },
];

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'concertoai-handoff-'));
  cwd = path.join(home, 'work', 'demo');
  mkdirSync(cwd, { recursive: true });
  // 隔离 home：`globalDir()` 走 `os.homedir()`，两者都在调用时读 env（不是模块加载时）
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('LANG', '');
  vi.stubEnv('LUMEN_LOCALE', '');
  resetHandoffState();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetHandoffState();
});

describe('四栏结构：标题固定、顺序固定、每一栏都非空', () => {
  it('四种 reason 下四栏都存在且顺序正确', () => {
    const messages: ChatMessage[] = [...editFile('c1', 'src/a.ts'), ...okCommand('c2', 'npm test')];
    for (const reason of REASONS) {
      const text = buildHandoff(messages, reason, { cwd, sessionId: 's1', now: FIXED_NOW });
      const order = ['## ① 做到哪一步', '## ② 验收', '## ③ 下一步', '## ④ 为什么退出'].map((h) =>
        text.indexOf(h),
      );
      expect(
        order.every((at) => at > -1),
        `${reason.kind}: 四栏标题必须齐全`,
      ).toBe(true);
      expect(
        [...order].sort((a, b) => a - b),
        `${reason.kind}: 顺序必须固定`,
      ).toEqual(order);
      for (const heading of ['## ① 做到哪一步', '## ② 验收', '## ③ 下一步', '## ④ 为什么退出']) {
        expect(
          section(text, heading).length,
          `${reason.kind} 的 ${heading} 不得为空`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('**空会话**也四栏齐全且写明「无记录」（不许留空串）', () => {
    const text = buildHandoff([], { kind: 'completed' }, { cwd, now: FIXED_NOW });
    expect(section(text, '## ① 做到哪一步')).toContain('无记录');
    expect(section(text, '## ② 验收')).toContain('无记录');
    expect(section(text, '## ③ 下一步')).toContain('无');
    expect(section(text, '## ④ 为什么退出')).toContain('正常收尾');
  });

  it('头部写清项目绝对路径 / 会话 / 写入时间 / 退出原因（消费端按这几行判新鲜度）', () => {
    const text = buildHandoff(
      [],
      { kind: 'interrupted' },
      { cwd, sessionId: 'sess-9', now: FIXED_NOW },
    );
    expect(text).toContain(`> 项目: ${path.resolve(cwd)}`);
    // ⚠️ 格式契约，别改成 t()（v5.4 候选 A，理由见 docs/14-测试断言分类盘点.md §四）
    expect(text).toContain('> 会话: sess-9');
    expect(text).toContain('> 写入时间: 2026-11-14T12:00:00.000Z');
    expect(text).toContain('> 退出原因: interrupted');
    // 没给 sessionId 时写「无」，不留 `undefined`
    expect(buildHandoff([], { kind: 'completed' }, { cwd, now: FIXED_NOW })).toContain(
      '> 会话: 无',
    );
  });
});

describe('④ 四种退出原因：文案两两不同，且不写死轮数', () => {
  it('四种文案互不相同（`new Set(...).size === 4`）', () => {
    const texts = REASONS.map((reason) => exitReasonText(reason));
    expect(new Set(texts).size).toBe(4);
    // 否定面：任意两句都不许互相包含（否则「撞上限」里能搜到「正常收尾」）
    for (let i = 0; i < texts.length; i += 1) {
      for (let j = 0; j < texts.length; j += 1) {
        if (i !== j) {
          expect(texts[j], `${texts[i]} 与 ${texts[j]} 不该互相包含`).not.toContain(texts[i]);
        }
      }
    }
  });

  it('`max-turns` 带**字面轮数**且来自入参（50/50 与 12/12 都出现 ⇒ 没写死）', () => {
    expect(exitReasonText({ kind: 'max-turns', used: 50, cap: 50 })).toContain('50/50');
    expect(exitReasonText({ kind: 'max-turns', used: 12, cap: 12 })).toContain('12/12');
  });

  it('`error` 只取消息首行，**不带堆栈**（`at ` 行不得出现）', () => {
    const text = exitReasonText({ kind: 'error', message: 'boom\n    at foo (bar.ts:1:1)' });
    expect(text).toContain('boom');
    expect(text).not.toContain('at foo');
    expect(text).not.toContain('bar.ts');
  });

  it('`completed` 不含「截断 / 轮数上限 / 中断 / 异常」（否定面精确到词）', () => {
    const text = exitReasonText({ kind: 'completed' });
    for (const word of ['轮数上限', '中断', '异常']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('① 做到哪一步', () => {
  it('取**最后一次成功** edit_file 的 path + 最后一条助手文本首行（截 80 字）', () => {
    const messages: ChatMessage[] = [
      ...editFile('a1', 'src/first.ts'),
      ...editFile('a2', 'src/second.ts'),
      // 首行本身就超 80 字：截断发生在**首行**上（`长`.repeat(200) 若放在第二行则不会被截）
      { role: 'assistant', content: `结论首行${'长'.repeat(200)}\n第二行不该出现` },
    ];
    const text = buildHandoff(messages, { kind: 'completed' }, { cwd, now: FIXED_NOW });
    const where = section(text, '## ① 做到哪一步');
    expect(where).toContain('src/second.ts'); // 最后那次
    expect(where).not.toContain('src/first.ts');
    expect(where).toContain('结论首行');
    expect(where).not.toContain('第二行不该出现');
    expect(where).toContain('…'); // 超 80 字被截断
  });

  it('**失败的** edit_file 不算「做到哪」（否则用户回去看一个没改成的文件）', () => {
    const messages: ChatMessage[] = [
      ...editFile('e1', 'src/ok.ts'),
      call('e2', 'edit_file', { path: 'src/never.ts' }),
      result('e2', formatToolFailure('edit_file', 'old_string 未找到')),
    ];
    const where = section(
      buildHandoff(messages, { kind: 'completed' }, { cwd, now: FIXED_NOW }),
      '## ① 做到哪一步',
    );
    expect(where).toContain('src/ok.ts');
    expect(where).not.toContain('src/never.ts');
  });
});

describe('② 验收：✅ / ❌ / ⏳ 三态分明，不许把「没结果」写成成功', () => {
  it('成功 ⇒ ✅、失败 ⇒ ❌ + 失败首行、**没回填 ⇒ ⏳**（不是 ✅）', () => {
    const messages: ChatMessage[] = [
      ...okCommand('c1', 'npm run lint'),
      ...failCommand('c2', 'npm run typecheck', 'error TS2322: 类型不匹配'),
      call('c3', 'run_command', { command: 'npm run build' }), // 中断，没有回填
    ];
    const acceptance = section(
      buildHandoff(messages, { kind: 'interrupted' }, { cwd, now: FIXED_NOW }),
      '## ② 验收',
    );
    expect(acceptance).toContain('✅ npm run lint');
    expect(acceptance).toContain('❌ npm run typecheck（失败：error TS2322: 类型不匹配）');
    expect(acceptance).toContain('⏳ npm run build（未返回结果）');
    // 否定面：那条没结果的命令**不得**带 ✅
    expect(acceptance).not.toContain('✅ npm run build');
  });

  it(`超过 ${MAX_ACCEPTANCE_LINES} 条 ⇒ 写「另有 N 条未列出」，且**失败项不会被截掉**`, () => {
    /**
     * 这条是本文件最重要的否定面：③ 栏靠「第一条失败」给出下一步，
     * 若失败被上限截掉，用户会看到「继续上次任务」而真相是有命令没过 —— **静默的谎**。
     */
    const messages: ChatMessage[] = [...failCommand('early', 'npm run verify', 'exit 1')];
    for (let i = 0; i < MAX_ACCEPTANCE_LINES + 5; i += 1) {
      messages.push(...okCommand(`ok-${i}`, `echo ${i}`));
    }
    const text = buildHandoff(
      messages,
      { kind: 'max-turns', used: 50, cap: 50 },
      { cwd, now: FIXED_NOW },
    );
    const acceptance = section(text, '## ② 验收');
    expect(acceptance).toContain('另有 6 条未列出');
    expect(acceptance, '最早那条失败必须被保留').toContain('❌ npm run verify');
    // ③ 也因此给出正确下一步
    expect(section(text, '## ③ 下一步')).toContain('npm run verify');
  });
});

describe('③ 下一步', () => {
  it('有失败 ⇒ 命令原文放进 bat 代码块（可直接复制重跑）', () => {
    const text = buildHandoff(
      [...failCommand('c1', 'npm run verify')],
      { kind: 'max-turns', used: 50, cap: 50 },
      { cwd, now: FIXED_NOW },
    );
    const next = section(text, '## ③ 下一步');
    expect(next).toContain('```bat');
    expect(next).toContain('npm run verify');
  });

  it('无失败但有工具 ⇒ 继续上次任务（带最后助手首行）', () => {
    const messages: ChatMessage[] = [
      ...okCommand('c1', 'npm test'),
      { role: 'assistant', content: '测试过了\n细节…' },
    ];
    const next = section(
      buildHandoff(messages, { kind: 'completed' }, { cwd, now: FIXED_NOW }),
      '## ③ 下一步',
    );
    expect(next).toContain('继续上次任务：测试过了');
    expect(next).not.toContain('```');
  });

  it('什么都没有 ⇒ 「无（上次已收尾）」', () => {
    const next = section(
      buildHandoff([], { kind: 'completed' }, { cwd, now: FIXED_NOW }),
      '## ③ 下一步',
    );
    expect(next).toContain('无（上次已收尾）');
  });
});

describe('isToolErrorContent：双向 + 「成功内容碰巧含标记」仍判成功', () => {
  it('真失败文本 ⇒ true；真成功文本 ⇒ false', () => {
    expect(isToolErrorContent(formatToolFailure('run_command', 'exit 1'))).toBe(true);
    expect(
      isToolErrorContent(formatToolResult({ ok: true, data: { stdout: 'ok' } }, 'run_command')),
    ).toBe(false);
    expect(isToolErrorContent(formatToolResult({ ok: false, error: 'x' }, 'run_command'))).toBe(
      true,
    );
  });

  it('**成功结果里合法地含有标记** ⇒ 仍 false（否则会把成功记成失败）', () => {
    const successWithMarker = formatToolResult(
      { ok: true, data: { content: 'AGENTS 原文：工具 run_command 执行失败: 样例' } },
      'read_file',
    );
    expect(successWithMarker).toContain('执行失败: '); // 前置：标记确实在
    expect(isToolErrorContent(successWithMarker)).toBe(false);
  });

  it('与 formatToolResult 同源：改标记两处一起变（源码级证据）', () => {
    expect(formatToolFailure('t', 'e')).toBe(formatToolResult({ ok: false, error: 'e' }, 't'));
  });

  it('`sessionHasToolCalls` 只看 tool 角色（纯闲聊返回 false）', () => {
    expect(
      sessionHasToolCalls([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ]),
    ).toBe(false);
    expect(sessionHasToolCalls([...okCommand('c1', 'ls')])).toBe(true);
  });
});

describe('落点与幂等（方案 B：~/.concertoai/handoffs/<项目 key>/）', () => {
  it('写到 `~/.concertoai/handoffs/<名>-<哈希>/handoff.md`，**不写**工作目录（也不碰 .git/info/exclude）', () => {
    const file = finalizeSession(
      [],
      { kind: 'completed' },
      { cwd, sessionId: 's1', now: FIXED_NOW },
    );
    expect(file).toBeDefined();
    expect(file?.startsWith(path.join(home, '.concertoai', 'handoffs'))).toBe(true);
    expect(file?.endsWith(path.join('handoff.md'))).toBe(true);
    expect(existsSync(file ?? '')).toBe(true);
    // 否定面：工作目录里不得出现交接单
    expect(existsSync(path.join(cwd, 'handoff.md'))).toBe(false);
    // 目录名带项目名，便于人辨认
    expect(path.basename(path.dirname(file ?? ''))).toMatch(/^demo-[0-9a-f]{12}$/);
  });

  it('同名不同路径的两个项目 ⇒ 不同目录（否则互相覆盖）', () => {
    const other = path.join(home, 'another', 'demo');
    mkdirSync(other, { recursive: true });
    expect(handoffPath(cwd)).not.toBe(handoffPath(other));
  });

  it('`terminal: true` 两次 ⇒ 只写一次（同一次退出被 exit() 与 SIGINT 双触发）', () => {
    const first = finalizeSession(
      [],
      { kind: 'interrupted' },
      { cwd, sessionId: 's1', now: FIXED_NOW },
      {
        terminal: true,
      },
    );
    const second = finalizeSession(
      [],
      { kind: 'interrupted' },
      { cwd, sessionId: 's1', now: FIXED_NOW },
      {
        terminal: true,
      },
    );
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it('**非 terminal 每次都写**（否则后来的 Ctrl+C 改不动 ④ 栏 = 留下过期记录）', () => {
    finalizeSession([], { kind: 'completed' }, { cwd, sessionId: 's1', now: FIXED_NOW });
    const file = handoffPath(cwd);
    // ⚠️ 格式契约，别改成 t()（v5.4 候选 A，理由见 docs/14-测试断言分类盘点.md §四）
    expect(readFileSync(file, 'utf8')).toContain('> 退出原因: completed');
    // 同一会话后来的退出必须能覆盖
    const again = finalizeSession(
      [],
      { kind: 'interrupted' },
      { cwd, sessionId: 's1', now: FIXED_NOW },
      {
        terminal: true,
      },
    );
    expect(again).toBeDefined();
    // ⚠️ 格式契约，别改成 t()（v5.4 候选 A，理由见 docs/14-测试断言分类盘点.md §四）
    expect(readFileSync(file, 'utf8')).toContain('> 退出原因: interrupted');
  });

  it('崩溃出口：有快照才写（没快照返回 undefined，**不编造空交接单**）', () => {
    expect(finalizeActiveSession({ kind: 'error', message: 'x' })).toBeUndefined();
    setActiveSession({ messages: [...okCommand('c1', 'npm test')], cwd, sessionId: 's9' });
    const file = finalizeActiveSession({ kind: 'error', message: 'boom' });
    expect(file).toBeDefined();
    expect(readFileSync(file ?? '', 'utf8')).toContain('异常退出：boom');
  });
});

/**
 * 出口 ③ 的**进程级兜底**（v5.3 C 轮真 TTY 实测补上）。
 *
 * 为什么单独立一组：这一组守的不是「函数写得对不对」，而是「真机上 Ctrl+C
 * 退出到底会不会走到它」。Ink 把 Ctrl+C 截在 `useInput` 之前（`App.js:151`
 * `handleExit(); return;`），raw mode 下又不产生 SIGINT ⇒ 此前两条接线在
 * 真机上都是死代码，而当时的源码护栏只钉「`exit()` 前调了收尾函数」，
 * 看上去全绿。**配变异探针**：把 `writeHandoffAtProcessExit` 改成恒
 * `return undefined` ⇒ 第 1 条红；去掉空会话判断 ⇒ 第 3 条红；去掉
 * terminal 幂等 ⇒ 第 4 条红（在真机上则表现为 PTY 探针 ④ 栏判红）。
 */
describe('出口 ③ 的进程级兜底（`process.exit` 时写「用户中断」）', () => {
  it('有快照 ⇒ 写「用户中断」（这是真机 Ctrl+C 退出唯一能走到的路径）', () => {
    setActiveSession({ messages: [...okCommand('c1', 'echo hi')], cwd, sessionId: 's1' });
    const file = writeHandoffAtProcessExit();
    expect(file).toBeDefined();
    const text = readFileSync(file ?? '', 'utf8');
    // ⚠️ 格式契约，别改成 t()（v5.4 候选 A，理由见 docs/14-测试断言分类盘点.md §四）
    expect(text).toContain('> 退出原因: interrupted');
    expect(text).toContain('用户中断');
    // 否定面：用户中断不得被说成异常，也不得留堆栈
    expect(text).not.toContain('异常退出');
    expect(text).not.toMatch(/\n\s+at .*:\d+:\d+/);
  });

  it('无快照（UI 没挂载过，如 `doctor`）⇒ 不写，连目录都不建', () => {
    expect(writeHandoffAtProcessExit()).toBeUndefined();
    expect(existsSync(path.join(home, '.concertoai', 'handoffs'))).toBe(false);
  });

  it('**空会话**（打开就退）⇒ 不写（AGENTS §已知边界 B1 的降噪裁决）', () => {
    setActiveSession({ messages: [], cwd, sessionId: 's1' });
    expect(writeHandoffAtProcessExit()).toBeUndefined();
    expect(existsSync(handoffPath(cwd))).toBe(false);
  });

  it('已由 terminal 出口写过（崩溃 `error`）⇒ **不覆盖**（异常原因不得被盖成「用户中断」）', () => {
    setActiveSession({ messages: [...okCommand('c1', 'echo hi')], cwd, sessionId: 's1' });
    expect(finalizeActiveSession({ kind: 'error', message: 'boom' })).toBeDefined();
    expect(writeHandoffAtProcessExit()).toBeUndefined();
    const text = readFileSync(handoffPath(cwd), 'utf8');
    expect(text).toContain('异常退出：boom');
    // ⚠️ 格式契约，别改成 t()（v5.4 候选 A，理由见 docs/14-测试断言分类盘点.md §四）
    expect(text).not.toContain('> 退出原因: interrupted');
  });

  it('`installHandoffExitHook` 装的是真监听，幂等且卸载后无残留', () => {
    const before = process.listenerCount('exit');
    const off = installHandoffExitHook();
    try {
      expect(process.listenerCount('exit'), '正例自证：确实加了 1 个 exit 监听').toBe(before + 1);
      const off2 = installHandoffExitHook();
      expect(process.listenerCount('exit'), '装两次只有一个监听').toBe(before + 1);
      off2();
      expect(process.listenerCount('exit'), '副卸载函数不动别人的监听').toBe(before + 1);
    } finally {
      off();
    }
    expect(process.listenerCount('exit'), '卸载后不留残留').toBe(before);
  });
});

describe('消费端：读取 + 新鲜度三段', () => {
  const writeWith = (writtenAt: Date, project = cwd): void => {
    const text = buildHandoff(
      [],
      { kind: 'max-turns', used: 50, cap: 50 },
      {
        cwd: project,
        now: writtenAt,
      },
    );
    const file = handoffPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  };

  it('文件不存在 ⇒ `none` 且 consume 什么都不给（不打印「未找到」这种噪音）', () => {
    expect(readHandoff(cwd, FIXED_NOW)).toEqual({ kind: 'none' });
    expect(consumeHandoff(cwd, FIXED_NOW)).toEqual({});
  });

  it('同项目 + 1 小时前 ⇒ fresh，notice 带短标签与**完整路径**，inject 是全文', () => {
    writeWith(new Date(FIXED_NOW.getTime() - 3_600_000));
    const { notice, inject } = consumeHandoff(cwd, FIXED_NOW);
    expect(notice).toContain('上次交接：撞轮数上限（50/50）');
    expect(notice, '落点 B 用户不易发现 ⇒ 必须打完整路径').toContain(handoffPath(cwd));
    // ⚠️ 格式契约，别改成 t()（v5.4 候选 A，理由见 docs/14-测试断言分类盘点.md §四）
    expect(inject).toContain('## ① 做到哪一步');
  });

  it('同项目 + 25 小时前 ⇒ stale(too-old)，**inject 必须为空**（否定面）', () => {
    writeWith(new Date(FIXED_NOW.getTime() - 25 * 3_600_000));
    const reading = readHandoff(cwd, FIXED_NOW);
    expect(reading.kind).toBe('stale');
    const { notice, inject } = consumeHandoff(cwd, FIXED_NOW);
    expect(notice).toContain('已忽略');
    expect(inject).toBeUndefined();
  });

  it('文件里记的项目不是当前项目 ⇒ stale(other-project)，即使时间很新也不注入', () => {
    const other = path.join(home, 'elsewhere');
    mkdirSync(other, { recursive: true });
    writeWith(FIXED_NOW, other); // 写到本项目路径，但头部项目是 another
    const reading = readHandoff(cwd, FIXED_NOW);
    expect(reading.kind).toBe('stale');
    expect(reading.kind === 'stale' && reading.why).toBe('other-project');
    expect(consumeHandoff(cwd, FIXED_NOW).inject).toBeUndefined();
  });

  it('**正常产物不会被截断**（② 栏 20 条上限已把体积压住——先立这个事实，再测防御）', () => {
    /**
     * 实测事实：`buildHandoff` 的输出受 `MAX_ACCEPTANCE_LINES = 20` 约束，
     * 200 条命令也只写出约 1.5K 字。所以下面的截断逻辑是**防御性**的
     * （防手改过的文件、旧版本产物、别处复制的长文），不是日常路径。
     * 这条用例先把「日常不会触发」钉下来，避免有人把上限当摆设乱调。
     */
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 200; i += 1) {
      messages.push(...okCommand(`c${i}`, `echo ${'x'.repeat(60)} ${i}`));
    }
    const text = buildHandoff(messages, { kind: 'completed' }, { cwd, now: FIXED_NOW });
    expect(text.length).toBeLessThan(MAX_INJECT_CHARS);
    const file = handoffPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
    const { inject } = consumeHandoff(cwd, FIXED_NOW);
    expect(inject).toBe(text); // 原样注入
    expect(inject).not.toContain('已截断');
  });

  it('**防御面**：文件被人为写超长 ⇒ 注入被截断并注明（带完整路径）', () => {
    const file = handoffPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    // 头部合法（时间新、项目对），正文很长：模拟手改 / 旧版本产物
    const header = buildHandoff([], { kind: 'completed' }, { cwd, now: FIXED_NOW }).split(
      '\n## ',
    )[0];
    writeFileSync(file, `${header}\n\n${'x'.repeat(MAX_INJECT_CHARS + 500)}`, 'utf8');
    const { inject } = consumeHandoff(cwd, FIXED_NOW);
    expect(inject).toBeDefined();
    expect(inject?.length).toBeLessThan(MAX_INJECT_CHARS + 200);
    expect(inject).toContain('已截断');
    expect(inject, '截断后必须给出完整路径，否则用户没法看剩下的').toContain(file);
  });
});
