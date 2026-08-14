/**
 * crash-handler unhandledRejection 兜底测试（v4.0.1 AbortError 识别）。
 *
 * 覆盖：AbortError（用户主动 Ctrl+C）→ 不写 crash.log、退出码 130；
 * 真实错误 → 写 crash.log、退出码 1。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { appendMock } = vi.hoisted(() => ({ appendMock: vi.fn() }));

// partial mock node:fs：仅替换 appendFileSync 以断言 crash.log 是否写入（其余保留原实现）
vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return { ...mod, appendFileSync: appendMock };
});

import { installCrashHandlers } from '../../src/cli/crash-handler';

describe('crash-handler unhandledRejection（v4.0.1 AbortError 兜底）', () => {
  const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

  afterEach(() => {
    exitMock.mockClear();
    appendMock.mockClear();
  });

  it('AbortError（用户 Ctrl+C）→ 不写 crash.log、退出码 130（SIGINT 惯例）', () => {
    installCrashHandlers();
    (process as NodeJS.EventEmitter).emit(
      'unhandledRejection',
      new DOMException('Aborted with Ctrl+C', 'AbortError'),
    );
    expect(appendMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(130);
  });

  it('真实错误 → 写 crash.log + 退出码 1（原 fail-closed 行为不变）', () => {
    installCrashHandlers();
    (process as NodeJS.EventEmitter).emit('unhandledRejection', new Error('boom'));
    expect(appendMock).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
