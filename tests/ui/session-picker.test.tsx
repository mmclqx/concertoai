import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../../src/store/session';
import { formatSessionTime, SessionPicker } from '../../src/ui/SessionPicker';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ESC = '\u001b';

const sessions: SessionSummary[] = [
  {
    id: '20260807-103000-000',
    createdAt: new Date(2026, 7, 7, 10, 30).getTime(),
    messageCount: 3,
    firstUserMessage: '第一个问题',
  },
  {
    id: '20260807-090000-000',
    createdAt: new Date(2026, 7, 7, 9, 0).getTime(),
    messageCount: 1,
    firstUserMessage: null,
  },
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('formatSessionTime', () => {
  it('格式化为 YYYY-MM-DD HH:mm（本地时区）', () => {
    expect(formatSessionTime(new Date(2026, 7, 7, 10, 30).getTime())).toBe('2026-08-07 10:30');
    expect(formatSessionTime(new Date(2026, 0, 3, 9, 5).getTime())).toBe('2026-01-03 09:05');
  });
});

describe('SessionPicker', () => {
  it('渲染时间、消息数与首条摘要（无摘要显示占位）', () => {
    const { lastFrame, unmount } = render(
      <SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('2026-08-07 10:30');
    expect(frame).toContain('3 条');
    expect(frame).toContain('第一个问题');
    expect(frame).toContain('1 条');
    expect(frame).toContain('（无用户消息）');
    unmount();
  });

  it('默认选中第一行，↓/↑ 移动高亮', async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain('› 2026-08-07 10:30');
    stdin.write(DOWN);
    await sleep(30);
    expect(lastFrame()).toContain('› 2026-08-07 09:00');
    stdin.write(UP);
    await sleep(30);
    expect(lastFrame()).toContain('› 2026-08-07 10:30');
    unmount();
  });

  it('Enter 回调选中的会话 id', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <SessionPicker sessions={sessions} onSelect={onSelect} onCancel={() => {}} />,
    );
    stdin.write(DOWN);
    await sleep(30);
    stdin.write('\r');
    await sleep(30);
    expect(onSelect).toHaveBeenCalledWith('20260807-090000-000');
    unmount();
  });

  it('Esc 触发取消回调', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <SessionPicker sessions={sessions} onSelect={() => {}} onCancel={onCancel} />,
    );
    stdin.write(ESC);
    await sleep(30);
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });
});
