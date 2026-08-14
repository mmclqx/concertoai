/**
 * 共享行输入 promptLine 测试（v4.0.1 Ctrl+C 崩溃链路修复）。
 *
 * 覆盖：非 TTY → undefined / Ctrl+C（AbortError）→ undefined（不抛错，不再触发
 * crash-handler 的 unhandledRejection）/ 正常输入 → trim / 其他错误原样上抛。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { questionMock, closeMock } = vi.hoisted(() => ({
  questionMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: () => ({ question: questionMock, close: closeMock }),
  },
}));

import { promptLine } from '../../src/cli/prompt';

const originalIsTTY = process.stdin.isTTY;

afterEach(() => {
  process.stdin.isTTY = originalIsTTY;
  vi.clearAllMocks();
});

describe('promptLine（v4.0.1 Ctrl+C 崩溃修复）', () => {
  it('非 TTY → 返回 undefined（不调用 readline）', async () => {
    process.stdin.isTTY = false;
    expect(await promptLine('q: ')).toBeUndefined();
    expect(questionMock).not.toHaveBeenCalled();
  });

  it('Ctrl+C（AbortError）→ 返回 undefined 且不抛错（不再被 crash-handler 误判为崩溃）', async () => {
    process.stdin.isTTY = true;
    questionMock.mockRejectedValueOnce(new DOMException('Aborted with Ctrl+C', 'AbortError'));
    await expect(promptLine('q: ')).resolves.toBeUndefined();
    expect(closeMock).toHaveBeenCalled();
  });

  it('正常输入 → 去除首尾空白返回', async () => {
    process.stdin.isTTY = true;
    questionMock.mockResolvedValueOnce('  y  ');
    await expect(promptLine('q: ')).resolves.toBe('y');
    expect(closeMock).toHaveBeenCalled();
  });

  it('其他错误 → 原样上抛（不吞真实异常）', async () => {
    process.stdin.isTTY = true;
    const boom = new Error('boom');
    questionMock.mockRejectedValueOnce(boom);
    await expect(promptLine('q: ')).rejects.toThrow('boom');
  });
});
