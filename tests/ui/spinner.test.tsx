import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { Spinner } from '../../src/ui/Spinner';

describe('Spinner', () => {
  it('显示动画帧与文本', () => {
    const { lastFrame, unmount } = render(<Spinner text="思索中" />);
    const frame = lastFrame();
    expect(frame).toContain('思索中');
    // 帧为 Braille spinner 字符之一
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    unmount();
  });

  it('动画帧随时间变化', async () => {
    const { lastFrame, unmount } = render(<Spinner text="执行中" />);
    const first = lastFrame();
    // 真实计时：等待超过一个帧间隔（80ms）后帧应变化
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = lastFrame();
    expect(second).not.toBe(first);
    unmount();
  });
});
