import { describe, expect, it } from 'vitest';

import {
  countMessageListTokens,
  countTokens,
  estimateMessageListTokens,
  estimateTokens,
  preloadTokenizer,
} from '../../src/model/tokenizer';

describe('countTokens (BPE 精确)', () => {
  it('空字符串为 0', () => {
    expect(countTokens('')).toBe(0);
  });

  it('纯英文 BPE 精确（常见词单 token）', () => {
    expect(countTokens('hello')).toBe(1);
    expect(countTokens('hello world')).toBe(2);
    expect(countTokens('1234')).toBe(2);
  });

  it('中文 BPE 精确', () => {
    expect(countTokens('你好世界')).toBe(2);
    expect(countTokens('中文优先')).toBe(3);
  });

  it('中英混合精确', () => {
    expect(countTokens('你好 hello')).toBe(2);
    expect(countTokens('修复 bug')).toBe(3);
  });

  it('空白与换行', () => {
    expect(countTokens('a\nb')).toBe(3);
    expect(countTokens('  ')).toBe(1);
  });

  it('emoji', () => {
    expect(countTokens('😀')).toBe(1);
  });
});

describe('countMessageListTokens (BPE 精确)', () => {
  it('每条消息 = 4 固定开销 + 内容 token', () => {
    expect(countMessageListTokens([{ role: 'user', content: '你好' }])).toBe(5);
    expect(countMessageListTokens([{ role: 'system', content: '' }])).toBe(4);
    expect(countMessageListTokens([{ role: 'user', content: null }])).toBe(4);
  });

  it('多消息累加', () => {
    const messages = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'hi' },
    ];
    expect(countMessageListTokens(messages)).toBe(12);
  });
});

describe('countTokens 覆盖混合场景', () => {
  it('代码片段', () => {
    const code = 'const x = 42;\nfunction hello() { return x; }';
    const tokens = countTokens(code);
    expect(tokens).toBeGreaterThan(0);
    // BPE 对代码通常比纯文本占更多 token
    expect(tokens).toBeGreaterThanOrEqual(5);
  });

  it('长中文文本', () => {
    const text = 'Lumen 是一款面向个人开发者的终端编码助手 CLI（DeepSeek 驱动，中文优先）。';
    const tokens = countTokens(text);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(50);
  });
});

describe('preloadTokenizer（后台预加载）', () => {
  it('调用不抛错，setImmediate 后编码器可用', async () => {
    expect(() => preloadTokenizer()).not.toThrow();
    // 等待 setImmediate 排队的加载任务执行
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(countTokens('hello')).toBe(1);
    expect(countTokens('你好世界')).toBe(2);
  });

  it('幂等：多次调用无副作用', async () => {
    preloadTokenizer();
    preloadTokenizer();
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(countTokens('hello world')).toBe(2);
    expect(countMessageListTokens([{ role: 'user', content: '你好' }])).toBe(5);
  });
});

describe('向后兼容别名', () => {
  it('estimateTokens 指向 countTokens', () => {
    expect(estimateTokens('hello')).toBe(countTokens('hello'));
    expect(estimateTokens('你好')).toBe(countTokens('你好'));
  });

  it('estimateMessageListTokens 指向 countMessageListTokens', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    expect(estimateMessageListTokens(msgs)).toBe(countMessageListTokens(msgs));
  });
});
