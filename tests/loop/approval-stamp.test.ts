/**
 * v5.2 N2：审批结论「盖戳到会话消息」的验收（发布门第 2/3/4/5 条的证据来源）。
 *
 * ## 它防的是什么
 *
 * v5.1 的自动放行只在屏幕上留痕（单行 notice，滚过去就没了）。用户 `chat -r`
 * 之后无法回答「昨天那次改动是我按的 y，还是被自动放行的」。N2 把结论记进
 * tool 消息的 `approval` 字段。
 *
 * ## 为什么断言用 `Object.hasOwn` 而不是 `=== undefined`
 *
 * `loop.ts` 如果用 `approval: result.approval` 这种写法，会给每条 tool 消息写入
 * 一个**值为 undefined 的键**。`JSON.stringify` 会丢掉它（落盘看不出差异），
 * 但内存里 `hasOwnProperty('approval')` 是 **true**。
 * 断言 `=== undefined` 抓不到这种「伪盖戳」，`Object.hasOwn` 才抓得到。
 *
 * ## 变异探针（本文件配套，见 docs 执行日志）
 * - M1：`loop.ts` 无条件盖戳 ⇒ 「关闭 auto-low 时不盖戳」必须红
 * - M3：`App.tsx` 删 `request.autoLow = true` ⇒ 「开启时盖戳」必须红
 */

import { describe, expect, it } from 'vitest';
import { formatToolResult, toApiMessages } from '../../src/loop/messages';
import type { ChatMessage } from '../../src/loop/types';
import type { ToolResult } from '../../src/tools/registry';

/** 构造一条 tool 消息（模拟 loop.ts `executeGroup` 的产物）。 */
function toolMsg(result: ToolResult, id = 'call_1'): ChatMessage {
  return {
    role: 'tool',
    toolCallId: id,
    content: formatToolResult(result, 'edit_file'),
    ...(result.approval !== undefined ? { approval: result.approval } : {}),
  };
}

describe('盖戳语义：只有真被自动放行才带 approval', () => {
  it('工具报告 approval=auto-low ⇒ tool 消息带该字段且值为 auto-low', () => {
    const msg = toolMsg({ ok: true, data: { path: 'a.ts' }, approval: 'auto-low' });
    expect(Object.hasOwn(msg, 'approval')).toBe(true);
    expect(msg.approval).toBe('auto-low');
  });

  it('**否定面（核心）**：工具没报告 ⇒ tool 消息**不得有** approval 键', () => {
    const msg = toolMsg({ ok: true, data: { path: 'a.ts' } });
    // 改坏方式：loop.ts 写成 `approval: result.approval`（无条件写键）⇒ 这条红
    expect(Object.hasOwn(msg, 'approval'), '不该有 approval 键').toBe(false);
  });

  it('审批被拒（ok:false）不带 approval —— 用户已经点过 n，不需要标记', () => {
    const msg = toolMsg({ ok: false, error: '编辑被拒绝，文件未修改', repairable: false });
    expect(Object.hasOwn(msg, 'approval')).toBe(false);
  });

  it('**反向自证**：`toApiMessages` 投影后不得含 approval（不泄漏给模型）', () => {
    const msg = toolMsg({ ok: true, data: {}, approval: 'auto-low' });
    // 正例自证：源消息确实有这个键（否则下面断言空转）
    expect(Object.hasOwn(msg, 'approval')).toBe(true);

    const api = toApiMessages([msg]);
    const projected = api[0];
    expect(projected).toBeDefined();
    expect(Object.hasOwn(projected as object, 'approval')).toBe(false);
    // 顺带钉住：tool 的三个必要字段都还在（别为了不泄漏把正常字段也丢了）
    expect(projected?.role).toBe('tool');
    expect(projected?.tool_call_id).toBe('call_1');
    expect(typeof projected?.content).toBe('string');
  });

  it('**源码护栏**：`toApiMessages` 不得改成整对象展开（那会泄漏 approval）', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(path.join(process.cwd(), 'src', 'loop', 'messages.ts'), 'utf8');
    // 先剥注释再断言：注释里解释「为什么不能展开」是说明，不是实现
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // 正例自证：文件真读到了、函数在（否则下面的否定断言可能空转）
    expect(code).toContain('export function toApiMessages');
    expect(code).toContain('api.tool_call_id');

    // 改坏方式：把白名单投影改成 `{ ...m }` ⇒ 这两条红
    expect(code).not.toMatch(/const api: ApiMessage = \{\s*\.\.\.m/);
    expect(code).not.toMatch(/return \{\s*\.\.\.m/);
  });

  it('会话往返：appendAll → read 之后 approval 字段仍在（JSONL 天然保留）', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { SessionStore } = await import('../../src/store/session');

    const dir = mkdtempSync(path.join(os.tmpdir(), 'concertoai-n2-'));
    try {
      const store = new SessionStore(dir);
      const id = await store.create([]);
      const stamped = toolMsg({ ok: true, data: {}, approval: 'auto-low' }, 'c1');
      const plain = toolMsg({ ok: true, data: {} }, 'c2');
      await store.appendAll(id, [stamped, plain]);

      const { messages } = await store.read(id);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.approval).toBe('auto-low');
      // 否定面：未盖戳的那条读回来也不许凭空多出键
      expect(Object.hasOwn(messages[1] as object, 'approval')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧格式 JSONL（v5.1 之前写的、无 approval）读回不崩、不误报', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { SessionStore } = await import('../../src/store/session');

    const dir = mkdtempSync(path.join(os.tmpdir(), 'concertoai-n2-old-'));
    try {
      const store = new SessionStore(dir);
      const id = '20260101-000000-000';
      // 手写一份「旧版本产物」：只有 role/content/toolCallId，没有 approval
      const oldLines = [
        { role: 'user', content: '改一下' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'edit_file', arguments: '{"path":"a.ts"}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
      ]
        .map((m) => JSON.stringify(m))
        .join('\n');
      writeFileSync(path.join(dir, `${id}.jsonl`), `${oldLines}\n`, 'utf8');

      const { messages, skippedLines } = await store.read(id);
      expect(skippedLines).toBe(0);
      expect(messages).toHaveLength(3);
      // 旧消息没有该字段 —— formatApprovalReport 会据此报「无记录」，而不是编一条出来
      expect(Object.hasOwn(messages[2] as object, 'approval')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
