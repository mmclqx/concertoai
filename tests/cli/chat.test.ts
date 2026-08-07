import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { printSessionList } from '../../src/cli/chat';
import { userMessage } from '../../src/loop/messages';
import { SessionStore } from '../../src/store/session';

let tmp: string;
let store: SessionStore;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
  store = new SessionStore(path.join(tmp, 'sessions'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('printSessionList（chat -l）', () => {
  it('按 id、时间、消息数、首条摘要输出', async () => {
    const id = await store.create([userMessage('这是一个很长的首个问题')]);
    await store.append(id, { role: 'assistant', content: '回答' });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await printSessionList(store);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain(id);
    expect(line).toContain('2 条');
    expect(line).toContain('这是一个很长的首个问题');
    log.mockRestore();
  });

  it('无会话时输出「暂无历史会话」', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await printSessionList(store);
    expect(log).toHaveBeenCalledWith('暂无历史会话');
    log.mockRestore();
  });
});
