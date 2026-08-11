/**
 * atomicReplace EXDEV 回退测试（v3.2 M1 / T1.4）。
 *
 * 覆盖：rename 跨文件系统抛 EXDEV → copyFile + unlink 回退（对齐 paths.ts migrateLegacyHome）。
 * 独立测试文件：vi.mock 模拟 rename/copyFile/unlink，避免污染 accounts.test.ts 的真实 fs 用例。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rename: vi.fn(), copyFile: vi.fn(), unlink: vi.fn() };
});

import * as fsPromises from 'node:fs/promises';

import { atomicReplace } from '../../src/store/accounts';

const renameMock = vi.mocked(fsPromises.rename);
const copyFileMock = vi.mocked(fsPromises.copyFile);
const unlinkMock = vi.mocked(fsPromises.unlink);

afterEach(() => {
  vi.clearAllMocks();
});

describe('atomicReplace（EXDEV 回退）', () => {
  it('rename 正常 → 仅 rename，回退函数不被调用', async () => {
    renameMock.mockResolvedValue(undefined);
    await atomicReplace('/tmp/a.tmp', '/target/config.json');
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledWith('/tmp/a.tmp', '/target/config.json');
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('rename 抛 EXDEV → 回退 copyFile + unlink（跨盘原子写降级）', async () => {
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    });
    renameMock.mockRejectedValue(exdev);
    copyFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);

    await atomicReplace('C:/tmp/a.tmp', 'D:/target/config.json');
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(copyFileMock).toHaveBeenCalledWith('C:/tmp/a.tmp', 'D:/target/config.json');
    expect(unlinkMock).toHaveBeenCalledWith('C:/tmp/a.tmp');
  });

  it('rename 抛非 EXDEV 错误 → 原样抛出，不触发回退', async () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    renameMock.mockRejectedValue(eacces);

    await expect(atomicReplace('/tmp/a.tmp', '/target/config.json')).rejects.toThrow('EACCES');
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('EXDEV 回退后无 tmp 残留（unlink 清理）', async () => {
    const exdev = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    renameMock.mockRejectedValue(exdev);
    copyFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);

    await atomicReplace('/tmp/a.tmp', '/target/config.json');
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });
});
