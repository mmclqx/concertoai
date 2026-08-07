import { describe, expect, it, vi } from 'vitest';

import { CONTEXT_BUDGET_RATIO, trimContext } from '../../src/loop/context';
import { assistantMessage, systemMessage, userMessage } from '../../src/loop/messages';

/** 构造一条内容约 200 token 的消息（中文 1 字 ≈ 1 token）。 */
function longMsg(role: 'user' | 'assistant', text: string): ReturnType<typeof userMessage> {
  const content = `${text}${'很'.repeat(196)}`;
  return role === 'user' ? userMessage(content) : assistantMessage(content);
}

describe('trimContext', () => {
  it('未超预算时原样返回，trimmed = 0，不记日志', () => {
    const messages = [userMessage('你好'), assistantMessage('你好呀')];
    const log = vi.fn();
    const result = trimContext(messages, 10_000, log);
    expect(result.messages).toBe(messages);
    expect(result.trimmed).toBe(0);
    expect(result.beforeTokens).toBe(result.afterTokens);
    expect(log).not.toHaveBeenCalled();
  });

  it('超预算时保留 system + 最近整轮，丢弃中间旧消息', () => {
    const messages = [
      systemMessage('项目规则'),
      longMsg('user', '第一问'),
      assistantMessage('第一答'),
      longMsg('user', '第二问'),
      assistantMessage('第二答'),
      userMessage('最新提问'),
    ];
    const result = trimContext(messages, 500, vi.fn());
    // 预算 = 400 token；保留 system + 最近两轮，丢弃更早的旧消息
    expect(result.trimmed).toBeGreaterThan(0);
    expect(result.messages[0]?.role).toBe('system');
    expect(result.messages[0]?.content).toBe('项目规则');
    expect(result.messages.at(-1)?.content).toBe('最新提问');
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('裁剪后不超过预算（或仅因整轮保留略超）', () => {
    const messages = Array.from({ length: 10 }, (_, i) => longMsg('user', `问题${i}`));
    const contextWindow = 2_000;
    const result = trimContext(messages, contextWindow, vi.fn());
    expect(result.trimmed).toBeGreaterThan(0);
    expect(result.afterTokens).toBeLessThanOrEqual(
      Math.floor(contextWindow * CONTEXT_BUDGET_RATIO) + 210,
    );
  });

  it('最新一组本身超预算时仍至少保留（含最新 user 消息）', () => {
    const huge = `超长问题${'长'.repeat(5_000)}`;
    const messages = [userMessage('早期问题'), userMessage(huge)];
    const result = trimContext(messages, 1_000, vi.fn());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe(huge);
  });

  it('裁剪前记录日志（含丢弃数与 token 变化）', () => {
    const messages = Array.from({ length: 8 }, (_, i) => longMsg('user', `问题${i}`));
    const log = vi.fn();
    const result = trimContext(messages, 1_000, log);
    expect(log).toHaveBeenCalledTimes(1);
    const msg = String(log.mock.calls[0]?.[0]);
    expect(msg).toContain('裁剪上下文');
    expect(msg).toContain(String(result.trimmed));
    expect(msg).toContain(String(result.beforeTokens));
    expect(msg).toContain(String(result.afterTokens));
  });
});
