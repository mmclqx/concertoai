/**
 * `/approvals` 斜杠命令测试（v5.2 N2）。
 *
 * 三条核心保证：
 * 1. **零记录必须有话可说**——空回执读起来像「命令没生效」（本仓的「假按钮」教训）；
 * 2. **只认 `approval === 'auto-low'`**——`role: 'tool'` 但没盖戳的不许混进报告
 *    （否定面：否则「所有改动都经过你确认」这句话会变成假话）；
 * 3. 配对失败/参数不合法**不许抛错、不许空白**（模型产物不可信）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectApprovalRecords,
  formatApprovalReport,
  MAX_APPROVAL_LINES,
  parseApprovalsCommand,
} from '../../src/cli/slash/approvals';
import { setLocale } from '../../src/i18n';
import type { ChatMessage } from '../../src/loop/types';

beforeEach(() => {
  setLocale('zh');
});

afterEach(() => {
  // 模块级全局状态必须复位（setLocale 写的是模块级变量，漏复位会让别处按顺序红）
  setLocale('zh');
});

/** 构造「一次自动放行」的完整消息对（assistant toolCalls + tool 结果）。 */
function autoApprovedEdit(id: string, file: string, result = '{"ok":true}'): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name: 'edit_file', arguments: JSON.stringify({ path: file }) }],
    },
    { role: 'tool', toolCallId: id, content: result, approval: 'auto-low' },
  ];
}

describe('汇总口径', () => {
  it('只收 approval=auto-low 的 tool 消息，并从配对的 toolCalls 反查文件名', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '改两个文件' },
      ...autoApprovedEdit('c1', 'src/math.js'),
      ...autoApprovedEdit('c2', 'src/api.ts'),
    ];
    const records = collectApprovalRecords(messages);
    expect(records).toHaveLength(2);
    expect(records[0]?.filePath).toBe('src/math.js');
    expect(records[0]?.toolName).toBe('edit_file');
    expect(records[1]?.filePath).toBe('src/api.ts');
  });

  it('**否定面**：role=tool 但没盖戳 ⇒ 一条都不收', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'edit_file', arguments: '{"path":"a.ts"}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' }, // 用户按 y 批准的
    ];
    // 改坏方式：把条件放宽成「所有 tool 消息」⇒ 这条红，且用户会被误导成「这次没问我」
    expect(collectApprovalRecords(messages)).toHaveLength(0);
  });

  it('配对失败的 toolCallId 也照样收（不抛错），明细退回「未知工具」', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', toolCallId: 'missing-id', content: 'x', approval: 'auto-low' },
    ];
    const records = collectApprovalRecords(messages);
    expect(records).toHaveLength(1);
    expect(records[0]?.filePath).toBeUndefined();

    const text = formatApprovalReport(messages);
    expect(text).toContain('未知工具');
    // toolCallId 不能丢：它是排查「这条对应哪次调用」的唯一线索（以附注形式出现）
    expect(text).toContain('missing-id');
    // 明细行不许是空白（用户看不出发生了什么）
    expect(text).toMatch(/1\.\s+\S+/);
  });

  it('toolCallId 缺失、content 为空 ⇒ 仍能给出可读明细（逐级兜底）', () => {
    const messages: ChatMessage[] = [{ role: 'tool', content: null, approval: 'auto-low' }];
    const text = formatApprovalReport(messages);
    expect(text).toContain('未知工具');
  });

  it('path 参数不是合法 JSON ⇒ 不抛错，退回工具名', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'edit_file', arguments: '{oops' }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'x', approval: 'auto-low' },
    ];
    const text = formatApprovalReport(messages);
    expect(text).toContain('edit_file');
  });
});

describe('报告文案', () => {
  it('有记录：首行含次数、明细含文件名', () => {
    const text = formatApprovalReport(autoApprovedEdit('c1', 'src/math.js'));
    expect(text).toContain('本会话自动放行 1 次');
    expect(text).toContain('src/math.js');
  });

  it('**否定面（核心）**：零记录 ⇒ 明确文案，且非空', () => {
    const text = formatApprovalReport([]);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('没有自动放行记录');
  });

  it('超长列表只列前 N 条，并告知还剩多少', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < MAX_APPROVAL_LINES + 5; i += 1) {
      messages.push(...autoApprovedEdit(`c${i}`, `f${i}.ts`));
    }
    const text = formatApprovalReport(messages);
    expect(text).toContain(`本会话自动放行 ${MAX_APPROVAL_LINES + 5} 次`);
    expect(text).toContain('另有 5 次未列出');
  });

  it('文案纪律：不许出现「安全」（未命中 ≠ 安全，延续 D93）', () => {
    const withRecords = formatApprovalReport(autoApprovedEdit('c1', 'a.ts'));
    const withoutRecords = formatApprovalReport([]);
    // 改坏方式：写成「已安全放行」⇒ 红
    expect(withRecords).not.toContain('安全');
    expect(withoutRecords).not.toContain('安全');
  });

  it('en 侧无 CJK 且有内容（换环境不漏中文）', () => {
    setLocale('en');
    const text = formatApprovalReport(autoApprovedEdit('c1', 'a.ts'));
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    const none = formatApprovalReport([]);
    expect(none.length).toBeGreaterThan(0);
    expect(none).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('命令解析', () => {
  it('裸 `/approvals` ⇒ 给出报告', () => {
    const result = parseApprovalsCommand('/approvals', autoApprovedEdit('c1', 'a.ts'));
    expect(result).not.toBeNull();
    expect(result?.handled).toBe(true);
    expect(result?.message.content).toContain('自动放行 1 次');
  });

  it('非本命令 ⇒ null（交给后续 handler）', () => {
    expect(parseApprovalsCommand('/hints', [])).toBeNull();
    expect(parseApprovalsCommand('帮我改代码', [])).toBeNull();
    // 前缀相同但不是本命令的边界
    expect(parseApprovalsCommand('/approvalsx', [])).toBeNull();
  });

  it('带参数 ⇒ 给用法提示（不静默、不报错）', () => {
    const result = parseApprovalsCommand('/approvals --json', []);
    expect(result?.handled).toBe(true);
    expect(result?.message.content).toContain('用法');
  });
});
