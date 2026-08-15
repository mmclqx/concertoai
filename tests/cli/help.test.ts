/**
 * --help 增强 + 首次欢迎引导测试（v4.1 T2.2，用户反馈 3）。
 *
 * 覆盖：--help 文本含新手三步 + 命令分组示例；maybePrintWelcome 标记文件
 * 两态（不存在 → 打印 + 创建标记；存在 → 不再打印）。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { zh } from '../../src/i18n/zh';

const originalHomedir = os.homedir;
let tmp: string;

describe('--help 增强（v4.1 T2.2）', () => {
  it('help 键组含新手三步 + 命令分组示例（en 结构一致性由 en.test.ts 覆盖）', () => {
    // 不 import cli/index（会触发 program.parse 副作用），直接断言帮助文案源
    expect(zh.help.gettingStarted).toContain('新手三步');
    expect(zh.help.step1).toContain('concertoai doctor');
    expect(zh.help.step2).toContain('concertoai chat');
    expect(zh.help.step3).toContain('workflow init');
    expect(zh.help.commands).toContain('命令速览');
    expect(zh.help.exampleChat).toContain('concertoai chat');
    expect(zh.help.exampleMarket).toContain('concertoai plugin browse');
  });
});

describe('maybePrintWelcome（v4.1 T2.2）', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeAll(() => {
    // 隔离全局目录：把 os.homedir 指向临时目录，避免污染真实 ~/.concertoai
    tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-welcome-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });

  afterAll(() => {
    os.homedir = originalHomedir;
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('首次（无标记文件）→ 打印欢迎 + 创建标记文件', async () => {
    const { maybePrintWelcome } = await import('../../src/cli/chat');
    maybePrintWelcome();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('欢迎使用 ConcertoAI');
    expect(out).toContain('concertoai doctor');
    // 标记文件已创建
    expect(existsSync(path.join(tmp, '.concertoai', '.welcome-seen'))).toBe(true);
  });

  it('再次（标记文件已存在）→ 不再打印', async () => {
    writeFileSync(path.join(tmp, '.concertoai', '.welcome-seen'), 'seen', 'utf8');
    const { maybePrintWelcome } = await import('../../src/cli/chat');
    maybePrintWelcome();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
