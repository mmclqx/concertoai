/**
 * 记忆管理斜杠命令测试。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeMemoryCommand, parseMemoryCommand } from '../../src/cli/slash/memory';
import { MemoryStore } from '../../src/store/memory-store';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-slash-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseMemoryCommand', () => {
  it('/remember 内容 → remember 命令', () => {
    const cmd = parseMemoryCommand('/remember 这是要记住的信息');
    expect(cmd?.type).toBe('remember');
    if (cmd?.type === 'remember') {
      expect(cmd.content).toBe('这是要记住的信息');
    }
  });

  it('/forget 关键词 → forget 命令', () => {
    const cmd = parseMemoryCommand('/forget 架构');
    expect(cmd?.type).toBe('forget');
  });

  it('/memories → memories 命令', () => {
    const cmd = parseMemoryCommand('/memories');
    expect(cmd?.type).toBe('memories');
  });

  it('非记忆命令返回 null', () => {
    expect(parseMemoryCommand('帮我重构代码')).toBeNull();
    expect(parseMemoryCommand('/plan 任务')).toBeNull();
  });

  it('无参数的 /remember 返回 unknown', () => {
    const cmd = parseMemoryCommand('/remember');
    expect(cmd?.type).toBe('unknown');
  });
});

describe('executeMemoryCommand', () => {
  it('/remember 写入记忆', async () => {
    const store = new MemoryStore({ cwd: tmp });
    const cmd = parseMemoryCommand('/remember 项目使用 DeepSeek 模型');
    if (cmd === null) throw new Error('unexpected');
    const result = await executeMemoryCommand(cmd, store);
    expect(result.handled).toBe(true);
    expect(result.message.content).toContain('已记忆');
    const all = await store.list();
    expect(all).toHaveLength(1);
  });

  it('/forget 删除匹配的记忆', async () => {
    const store = new MemoryStore({ cwd: tmp });
    await store.create('测试记忆', '内容');
    const cmd = parseMemoryCommand('/forget 测试');
    if (cmd === null) throw new Error('unexpected');
    const result = await executeMemoryCommand(cmd, store);
    expect(result.handled).toBe(true);
    const all = await store.list();
    expect(all).toHaveLength(0);
  });

  it('/memories 列出所有记忆', async () => {
    const store = new MemoryStore({ cwd: tmp });
    await store.create('记忆A', '内容A');
    await store.create('记忆B', '内容B');
    const cmd = parseMemoryCommand('/memories');
    if (cmd === null) throw new Error('unexpected');
    const result = await executeMemoryCommand(cmd, store);
    expect(result.handled).toBe(true);
    expect(result.message.content).toContain('2');
  });
});
