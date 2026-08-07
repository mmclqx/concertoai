import { render } from 'ink-testing-library';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { PromptInput } from '../../src/ui/PromptInput';

const REV_ON = '\u001b[7m';
const REV_OFF = '\u001b[27m';
const LEFT = '\u001b[D';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const HOME = '\u001b[H';
const END = '\u001b[F';
const DEL = '\u001b[3~';
const BACKSPACE = '\u0008';

interface Harness {
  stdin: ReturnType<typeof render>['stdin'];
  lastFrame: () => string | undefined;
  unmount: () => void;
  submitted: string[];
}

function setup(active = true): Harness {
  const submitted: string[] = [];
  function Harness() {
    const [value, setValue] = useState('');
    return (
      <PromptInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          submitted.push(v);
          setValue('');
        }}
        active={active}
      />
    );
  }
  const { stdin, lastFrame, unmount } = render(<Harness />);
  return { stdin, lastFrame, unmount, submitted };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 剥离 ANSI 转义序列，便于断言纯文本内容。 */
// biome-ignore lint/complexity/useRegexLiterals: 正则字面量里的 \u001b 会触发 noControlCharactersInRegex
const ANSI_SEQ_RE = new RegExp('\u001b\\[[0-9;]*m', 'g');

function stripAnsi(s: string | undefined): string {
  return (s ?? '').replace(ANSI_SEQ_RE, '');
}

describe('PromptInput 光标', () => {
  it('输入字符追加到末尾，光标标记在末尾（反显空格）', async () => {
    const h = setup();
    h.stdin.write('abc');
    await sleep(30);
    const frame = h.lastFrame();
    expect(frame).toContain(`abc${REV_ON} ${REV_OFF}`);
    h.unmount();
  });

  it('← 移动光标后输入插入到光标处', async () => {
    const h = setup();
    h.stdin.write('ac');
    await sleep(30);
    h.stdin.write(LEFT);
    await sleep(30);
    h.stdin.write('b');
    await sleep(30);
    expect(stripAnsi(h.lastFrame())).toContain('abc');
    h.unmount();
  });

  it('Home/End 跳转行首/行尾', async () => {
    const h = setup();
    h.stdin.write('abc');
    await sleep(30);
    h.stdin.write(HOME);
    await sleep(30);
    h.stdin.write('X');
    await sleep(30);
    expect(stripAnsi(h.lastFrame())).toContain('Xabc');
    h.stdin.write(END);
    await sleep(30);
    h.stdin.write('Y');
    await sleep(30);
    expect(stripAnsi(h.lastFrame())).toContain('XabcY');
    h.unmount();
  });

  it('Backspace 删除光标前字符，Delete 删除光标处字符', async () => {
    const h = setup();
    h.stdin.write('abcd');
    await sleep(30);
    h.stdin.write(LEFT);
    await sleep(30);
    h.stdin.write(BACKSPACE);
    await sleep(30);
    // 光标在 d 上，Backspace 删除其前字符 c → abd
    expect(stripAnsi(h.lastFrame())).toContain('abd');
    h.stdin.write(DEL);
    await sleep(30);
    // 光标仍在 d 上，Delete 删除光标处字符 d → ab
    expect(stripAnsi(h.lastFrame())).toContain('ab');
    h.unmount();
  });

  it('active=false 时按键被忽略', async () => {
    const h = setup(false);
    h.stdin.write('xyz');
    await sleep(30);
    // 边框始终渲染，但输入文本不应出现
    const frame = h.lastFrame() ?? '';
    expect(frame).not.toContain('xyz');
    h.unmount();
  });
});

describe('PromptInput 历史', () => {
  it('Enter 提交并记录历史，↑/↓ 浏览', async () => {
    const h = setup();
    h.stdin.write('第一条');
    await sleep(30);
    h.stdin.write('\r');
    await sleep(30);
    h.stdin.write('第二条');
    await sleep(30);
    h.stdin.write('\r');
    await sleep(30);
    expect(h.submitted).toEqual(['第一条', '第二条']);
    // ↑ 回到第二条，再 ↑ 回第一条
    h.stdin.write(UP);
    await sleep(30);
    expect(h.lastFrame()).toContain('第二条');
    h.stdin.write(UP);
    await sleep(30);
    expect(h.lastFrame()).toContain('第一条');
    // ↓ 回第二条，再 ↓ 恢复空输入
    h.stdin.write(DOWN);
    await sleep(30);
    expect(h.lastFrame()).toContain('第二条');
    h.stdin.write(DOWN);
    await sleep(30);
    expect(h.lastFrame()).not.toContain('第二条');
    h.unmount();
  });

  it('历史去重：重复提交只记录一次', async () => {
    const h = setup();
    for (const text of ['重复', '重复', '不同', '重复']) {
      h.stdin.write(text);
      await sleep(20);
      h.stdin.write('\r');
      await sleep(20);
    }
    expect(h.submitted).toEqual(['重复', '重复', '不同', '重复']);
    // 历史应为 [不同, 重复]（去重后），↑ 最新是「重复」，再 ↑ 是「不同」
    h.stdin.write(UP);
    await sleep(30);
    expect(h.lastFrame()).toContain('重复');
    h.stdin.write(UP);
    await sleep(30);
    expect(h.lastFrame()).toContain('不同');
    h.unmount();
  });
});
