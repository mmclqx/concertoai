import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assistantMessage,
  systemMessage,
  toolResultMessage,
  userMessage,
} from '../../src/loop/messages';
import { DEFAULT_SESSION_DIR, SessionStore } from '../../src/store/session';

let tmp: string;
let store: SessionStore;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
  store = new SessionStore(path.join(tmp, 'sessions'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('SessionStore 基础', () => {
  it('默认目录为 ~/.lumen/sessions', () => {
    expect(DEFAULT_SESSION_DIR).toBe(path.join(os.homedir(), '.lumen', 'sessions'));
    expect(new SessionStore().directory).toBe(DEFAULT_SESSION_DIR);
  });

  it('create 写入后 read 完整往返（含 tool 消息与 toolCalls）', async () => {
    const messages = [
      systemMessage('规则'),
      userMessage('你好'),
      assistantMessage('这是回复', [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }]),
      toolResultMessage('c1', '工具结果'),
    ];
    const id = await store.create(messages);
    expect(id).toMatch(/^\d{8}-\d{6}-\d{3}$/);

    const { messages: readBack, skippedLines } = await store.read(id);
    expect(skippedLines).toBe(0);
    expect(readBack).toEqual(messages);
  });

  it('中文内容往返无损', async () => {
    const id = await store.create([userMessage('中文优先，你好世界')]);
    const { messages } = await store.read(id);
    expect(messages[0]?.content).toBe('中文优先，你好世界');
  });

  it('create 空消息 → 空文件，read 返回空列表', async () => {
    const id = await store.create([]);
    const { messages, skippedLines } = await store.read(id);
    expect(messages).toHaveLength(0);
    expect(skippedLines).toBe(0);
  });

  it('append 追加消息后可续接读取', async () => {
    const id = await store.create([userMessage('第一问')]);
    await store.append(id, assistantMessage('第一答'));
    await store.appendAll(id, [userMessage('第二问'), assistantMessage('第二答')]);
    const { messages } = await store.read(id);
    expect(messages.map((m) => m.content)).toEqual(['第一问', '第一答', '第二问', '第二答']);
  });

  it('append 到不存在的 id 自动创建文件', async () => {
    await store.append('20260101-000000-000', assistantMessage('x'));
    const { messages } = await store.read('20260101-000000-000');
    expect(messages).toHaveLength(1);
  });

  it('read 不存在的会话抛错', async () => {
    await expect(store.read('20260101-000000-000')).rejects.toThrow();
  });
});

describe('SessionStore 健壮性', () => {
  it('损坏行跳过并计数，空行忽略', async () => {
    const id = await store.create([userMessage('好行')]);
    const file = path.join(tmp, 'sessions', `${id}.jsonl`);
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8')}{"role":"user","content":"坏行"\n\n{also broken}\n`,
      'utf8',
    );
    const { messages, skippedLines } = await store.read(id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('好行');
    expect(skippedLines).toBe(2);
  });

  it('非法 id（路径穿越）被拒绝', async () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', 'a:b']) {
      await expect(store.append(bad, userMessage('y'))).rejects.toThrow('非法的会话 id');
      await expect(store.read(bad)).rejects.toThrow('非法的会话 id');
      await expect(store.appendAll(bad, [userMessage('y')])).rejects.toThrow('非法的会话 id');
    }
  });

  it('list 返回会话摘要，最新在前，首条 user 消息截断', async () => {
    const longText = `这是一条很长的用户消息，超过四十个字符用来验证摘要截断逻辑是否正确生效${'啊'.repeat(20)}`;
    const id1 = await store.create([systemMessage('sys'), userMessage(longText)]);
    await store.append(id1, assistantMessage('回答'));
    const id2 = await store.create([userMessage('第二条会话')]);
    const id3 = await store.create([]);

    const list = await store.list();
    expect(list).toHaveLength(3);
    // 最新在前
    expect(list[0]?.id).toBe(id3);
    expect(list[1]?.id).toBe(id2);
    expect(list[2]?.id).toBe(id1);

    const s1 = list.find((s) => s.id === id1);
    expect(s1?.messageCount).toBe(3);
    expect(s1?.firstUserMessage?.length).toBe(40);
    expect(s1?.firstUserMessage?.startsWith('这是一条很长的用户消息')).toBe(true);
    expect(s1?.firstUserMessage?.endsWith('啊')).toBe(true);
    expect(list.find((s) => s.id === id2)?.firstUserMessage).toBe('第二条会话');
    expect(list.find((s) => s.id === id3)?.messageCount).toBe(0);
    expect(list.find((s) => s.id === id3)?.firstUserMessage).toBeNull();
  });

  it('list 忽略非 .jsonl 文件', async () => {
    await store.create([userMessage('x')]);
    writeFileSync(path.join(tmp, 'sessions', 'note.txt'), 'not a session');
    const list = await store.list();
    expect(list).toHaveLength(1);
  });
});
