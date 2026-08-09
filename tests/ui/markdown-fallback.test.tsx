import { describe, expect, it, vi } from 'vitest';

import { ensureHighlight, renderMarkdownToAnsi } from '../../src/ui/markdown';

// 模拟 cli-highlight 加载成功但解析抛错（或语言模块缺失），
// 验证延迟加载回退路径：代码块按原文输出、不抛错、无 ANSI 颜色码。
// vitest 会 hoist vi.mock 到 import 之前，动态 import 同样被拦截。
vi.mock('cli-highlight', () => ({
  highlight: () => {
    throw new Error('mock highlight failure');
  },
}));

describe('cli-highlight 加载失败回退', () => {
  it('高亮模块抛错时代码块回退原文（不抛错、无 ANSI）', async () => {
    await ensureHighlight();
    const out = renderMarkdownToAnsi('```ts\nconst x = 1;\n```');
    expect(out).toContain('const x = 1;');
    // 回退输出不包含 ANSI 颜色码（sanitize 后的原文）
    expect(out).not.toContain('\u001b[');
    // 围栏行本身不输出
    expect(out).not.toContain('```');
  });
});
