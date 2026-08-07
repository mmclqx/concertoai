import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { renderMarkdownToAnsi } from '../../src/ui/markdown';
import { StreamingView } from '../../src/ui/StreamingView';

const BOLD = '\u001b[1m';
const CYAN = '\u001b[36m';
const RESET = '\u001b[0m';

describe('renderMarkdownToAnsi', () => {
  it('标题渲染为加粗', () => {
    expect(renderMarkdownToAnsi('# 大标题')).toBe(`${BOLD}大标题${RESET}`);
    expect(renderMarkdownToAnsi('### 三级标题')).toBe(`${BOLD}三级标题${RESET}`);
  });

  it('无序列表项转为 • 前缀，编号列表保留编号', () => {
    expect(renderMarkdownToAnsi('- 第一项')).toBe('• 第一项');
    expect(renderMarkdownToAnsi('* 星号项')).toBe('• 星号项');
    expect(renderMarkdownToAnsi('1. 编号项')).toBe('1. 编号项');
  });

  it('加粗与行内代码渲染为 ANSI 样式', () => {
    expect(renderMarkdownToAnsi('这是 **重点** 内容')).toBe(`这是 ${BOLD}重点${RESET} 内容`);
    expect(renderMarkdownToAnsi('运行 `npm test` 即可')).toBe(`运行 ${CYAN}npm test${RESET} 即可`);
  });

  it('混合行内样式按顺序解析', () => {
    expect(renderMarkdownToAnsi('**粗**和`码`')).toBe(`${BOLD}粗${RESET}和${CYAN}码${RESET}`);
  });

  it('代码块使用 cli-highlight 语法高亮（输出含 ANSI 颜色码）', () => {
    const out = renderMarkdownToAnsi('```ts\nconst x = 1;\n```');
    expect(out).toContain('const');
    expect(out).toContain('\u001b[');
    // 围栏行本身不输出
    expect(out).not.toContain('```');
  });

  it('未知语言代码块回退原文（不抛错）', () => {
    const out = renderMarkdownToAnsi('```no-such-lang-xyz\nhello world\n```');
    expect(out).toContain('hello world');
  });

  it('未闭合代码块容错：内容按代码块输出', () => {
    const out = renderMarkdownToAnsi('```js\nconst a = 1;');
    expect(out).toContain('const');
    expect(out).toContain('a =');
    expect(out).toContain('\u001b[');
  });

  it('剥离输入中的控制字符（防终端注入）', () => {
    const out = renderMarkdownToAnsi('正常文本\u001b[31m红色注入\u001b[0m');
    expect(out).not.toContain('\u001b');
    expect(out).toContain('正常文本');
    expect(out).toContain('红色注入');
  });

  it('空行与普通段落原样保留', () => {
    const out = renderMarkdownToAnsi('第一段\n\n第二段');
    expect(out).toBe('第一段\n\n第二段');
  });
});

describe('StreamingView', () => {
  it('渲染 markdown 并输出 ANSI（含代码高亮）', () => {
    const markdownText = '# 标题\\n```ts\\nconst y: number = 2;\\n```';
    const { lastFrame, unmount } = render(<StreamingView text={markdownText} />);
    const frame = lastFrame();
    expect(frame).toContain('标题');
    expect(frame).toContain('\u001b[');
    expect(frame).toContain('const');
    unmount();
  });

  it('空文本显示思考中', () => {
    const { lastFrame, unmount } = render(<StreamingView text="" />);
    expect(lastFrame()).toContain('思考中');
    unmount();
  });
});
