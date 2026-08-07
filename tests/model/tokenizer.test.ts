import { describe, expect, it } from 'vitest';

import { estimateMessageListTokens, estimateTokens } from '../../src/model/tokenizer';

describe('estimateTokens', () => {
  it('空字符串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯英文按 4 字符 1 token 向上取整', () => {
    expect(estimateTokens('hello')).toBe(2);
    expect(estimateTokens('hello world')).toBe(3);
    expect(estimateTokens('1234')).toBe(1);
  });

  it('中文按 1 字符 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('中文优先')).toBe(4);
  });

  it('中英混合加权', () => {
    expect(estimateTokens('你好 hello')).toBe(4);
    expect(estimateTokens('修复 bug')).toBe(3);
  });

  it('空白与换行计入其余字符', () => {
    expect(estimateTokens('a\nb')).toBe(1);
    expect(estimateTokens('  ')).toBe(1);
  });

  it('emoji（代理对）按 2 个 code unit 计入其余字符', () => {
    expect(estimateTokens('😀')).toBe(1);
  });
});

describe('estimateMessageListTokens', () => {
  it('每条消息 = 4 固定开销 + 内容估算', () => {
    expect(estimateMessageListTokens([{ role: 'user', content: '你好' }])).toBe(6);
    expect(estimateMessageListTokens([{ role: 'system', content: '' }])).toBe(4);
    expect(estimateMessageListTokens([{ role: 'user', content: null }])).toBe(4);
  });

  it('多消息累加', () => {
    const messages = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'hi' },
    ];
    expect(estimateMessageListTokens(messages)).toBe(4 + 4 + 4 + 1);
  });
});
