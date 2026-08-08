import { describe, expect, it, vi } from 'vitest';

import { CONTEXT_BUDGET_RATIO, compressContext, trimContext } from '../../src/loop/context';
import { assistantMessage, systemMessage, userMessage } from '../../src/loop/messages';
import type { ChatMessage } from '../../src/loop/types';
import type { ChatCompletionChunk, ModelClient } from '../../src/model/client';

/** 构造一条内容约 200 token 的消息（中文 1 字 ≈ 1 token，BPE 近似）。 */
function longMsg(role: 'user' | 'assistant', text: string): ChatMessage {
  const content = `${text}${'很'.repeat(196)}`;
  return role === 'user' ? userMessage(content) : assistantMessage(content);
}

// ── trimContext（同步裁剪）测试 ────────────────────────────────

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

// ── compressContext（异步智能压缩）测试 ────────────────────────

/** 简单 FakeModel：返回固定内容。用于 compressContext 不触发摘要的路径。 */
function fakeModel(content: string): ModelClient {
  return {
    async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
      yield fakeChunk({ content });
      yield fakeChunk({}, 'stop');
    },
  };
}

/** 可脚本化的 FakeModel：按序消费回复。 */
class ScriptedModel implements ModelClient {
  received: ChatCompletionChunk[][] = [];
  private idx = 0;

  constructor(private readonly script: ChatCompletionChunk[][]) {}

  async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
    const chunks = this.script[this.idx];
    this.idx += 1;
    if (chunks === undefined) {
      throw new Error('ScriptedModel 脚本耗尽');
    }
    for (const c of chunks) {
      this.received.push([c]);
      yield c;
    }
  }
}

function fakeChunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

const baseOptions = {
  client: fakeModel('忽略'),
  model: 'deepseek-v4-flash',
  contextWindow: 10_000,
};

describe('compressContext', () => {
  it('未超预算时原样返回，summarized = false', async () => {
    const messages = [userMessage('你好'), assistantMessage('你好呀')];
    const result = await compressContext(messages, baseOptions);
    expect(result.messages).toBe(messages);
    expect(result.trimmed).toBe(0);
    expect(result.summarized).toBe(false);
    expect(result.summary).toBeUndefined();
  });

  it('超预算但丢弃 ≤ 5 条：回退裁剪，不调模型', async () => {
    // 少量消息超预算 → 直接裁剪
    const messages = [
      systemMessage('项目规则'),
      longMsg('user', '第一问'),
      assistantMessage('第一答'),
      userMessage('最新提问'),
      longMsg('user', '很长的第三问'),
    ];
    const log = vi.fn();
    const result = await compressContext(messages, {
      ...baseOptions,
      contextWindow: 300,
      log,
    });
    expect(result.trimmed).toBeGreaterThan(0);
    expect(result.summarized).toBe(false);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('超预算且丢弃 > 5 条：调用模型生成摘要', async () => {
    // 构造足够多的消息触发摘要（> 5 条被丢弃）
    const messages = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? longMsg('user', `问题${i}`) : assistantMessage(`回答${i}`),
    );
    // 第一个调用是摘要生成（返回摘要文本），第二个调用不会被触发（因为 compressContext 只调一次）
    const model = new ScriptedModel([
      [fakeChunk({ content: '这是对话摘要内容' }), fakeChunk({}, 'stop')],
    ]);
    const log = vi.fn();
    const result = await compressContext(messages, {
      client: model,
      model: 'deepseek-v4-flash',
      contextWindow: 400,
      log,
    });
    expect(result.summarized).toBe(true);
    expect(result.summary).toBe('这是对话摘要内容');
    // 摘要消息应注入为 system 角色
    const summaryMsg = result.messages.find((m) => m.content?.startsWith('# 对话摘要'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.role).toBe('system');
    expect(log).toHaveBeenCalled();
    const logMsg = String(log.mock.calls[0]?.[0]);
    expect(logMsg).toContain('已生成摘要');
  });

  it('摘要生成失败（抛错）：回退到裁剪策略', async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? longMsg('user', `问题${i}`) : assistantMessage(`回答${i}`),
    );
    const failingModel: ModelClient = {
      async *streamChat() {
        yield fakeChunk({ content: 'x' });
        throw new Error('网络错误');
      },
    };
    const log = vi.fn();
    const result = await compressContext(messages, {
      client: failingModel,
      model: 'deepseek-v4-flash',
      contextWindow: 400,
      log,
    });
    expect(result.summarized).toBe(false);
    expect(result.messages.length).toBeLessThan(messages.length);
    const logMsg = String(log.mock.calls[0]?.[0]);
    expect(logMsg).toContain('回退');
  });

  it('摘要为空：回退到裁剪策略', async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? longMsg('user', `问题${i}`) : assistantMessage(`回答${i}`),
    );
    const emptyModel = new ScriptedModel([
      [fakeChunk({}, 'stop')], // 空摘要
    ]);
    const log = vi.fn();
    const result = await compressContext(messages, {
      client: emptyModel,
      model: 'deepseek-v4-flash',
      contextWindow: 400,
      log,
    });
    expect(result.summarized).toBe(false);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('摘要生成后 token 仍超预算 → 二次裁剪', async () => {
    // 构造极端场景：摘要 + 保留消息仍超预算
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? longMsg('user', `问题${i}`) : assistantMessage(`回答${i}`),
    );
    const model = new ScriptedModel([[fakeChunk({ content: '摘要' }), fakeChunk({}, 'stop')]]);
    const log = vi.fn();
    const result = await compressContext(messages, {
      client: model,
      model: 'deepseek-v4-flash',
      contextWindow: 200, // 极低预算
      log,
    });
    // 应该仍然成功（摘要或二次裁剪后不抛错）
    expect(result.messages.length).toBeGreaterThan(0);
    // 至少有一条 system 消息
    expect(result.messages.some((m) => m.role === 'system')).toBe(true);
  });
});
