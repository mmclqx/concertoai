import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  listDirectoryTool,
  MAX_READ_CHARS,
  MAX_SEARCH_RESULTS,
  readFileTool,
  searchContentTool,
} from '../../src/tools/read';
import type { ToolContext, ToolSpec } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';

let tmp: string;
let ctx: ToolContext;
let registry: ToolRegistry;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-test-'));
  ctx = { cwd: tmp };
  registry = new ToolRegistry()
    .register(readFileTool)
    .register(listDirectoryTool)
    .register(searchContentTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): string {
  const full = path.join(tmp, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** 走完整分发链（zod 校验 + 异常捕获），与 registry.run 行为一致。 */
async function runTool(spec: ToolSpec, args: unknown): Promise<ReturnType<ToolRegistry['run']>> {
  return registry.run(spec.name, args, ctx);
}

describe('read_file', () => {
  it('读取文本文件完整内容', async () => {
    write('a.txt', 'hello concertoai');
    const result = await runTool(readFileTool, { path: 'a.txt' });
    expect(result.ok).toBe(true);
    const data = result.data as { content: string; truncated: boolean; totalChars: number };
    expect(data.content).toBe('hello concertoai');
    expect(data.truncated).toBe(false);
    // 'hello concertoai' = 5 + 1 + 10 = 16 字符（与实现 totalChars = content.length 一致）
    expect(data.totalChars).toBe(16);
  });

  it('读取带 UTF-8 BOM 的文件时剥离 BOM', async () => {
    write('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]));
    const result = await runTool(readFileTool, { path: 'bom.txt' });
    expect(result.ok).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe('hello');
  });

  it('子目录相对路径可读', async () => {
    write('sub/deep.txt', 'ok');
    const result = await runTool(readFileTool, { path: path.join('sub', 'deep.txt') });
    expect(result.ok).toBe(true);
  });

  it('文件不存在返回 ok:false', async () => {
    const result = await runTool(readFileTool, { path: 'missing.txt' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/ENOENT/);
  });

  it('读取目录返回 ok:false', async () => {
    mkdirSync(path.join(tmp, 'adir'));
    const result = await runTool(readFileTool, { path: 'adir' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('不是文件');
  });

  it('路径越界（.. 逃逸与绝对路径）被拒绝', async () => {
    const escapeResult = await runTool(readFileTool, { path: path.join('..', 'secret.txt') });
    expect(escapeResult.ok).toBe(false);
    expect(String(escapeResult.error)).toContain('越界');

    const outside = await runTool(readFileTool, { path: path.resolve(tmp, '..') });
    expect(outside.ok).toBe(false);
    expect(String(outside.error)).toContain('越界');
  });

  it('超长文件截断并标记 truncated', async () => {
    const big = 'x'.repeat(MAX_READ_CHARS + 10_000);
    write('big.txt', big);
    const result = await runTool(readFileTool, { path: 'big.txt' });
    expect(result.ok).toBe(true);
    const data = result.data as { content: string; truncated: boolean; totalChars: number };
    expect(data.truncated).toBe(true);
    expect(data.content.length).toBe(MAX_READ_CHARS);
    expect(data.totalChars).toBe(MAX_READ_CHARS + 10_000);
  });
});

describe('list_directory', () => {
  it('列出文件（含大小）与子目录，按名称排序', async () => {
    write('b.txt', '0123456789');
    write('a.txt', 'x');
    mkdirSync(path.join(tmp, 'sub'));
    const result = await runTool(listDirectoryTool, { path: '.' });
    expect(result.ok).toBe(true);
    const data = result.data as { entries: Array<{ name: string; type: string; size?: number }> };
    expect(data.entries).toEqual([
      { name: 'a.txt', type: 'file', size: 1 },
      { name: 'b.txt', type: 'file', size: 10 },
      { name: 'sub', type: 'dir', size: undefined },
    ]);
  });

  it('目录不存在返回 ok:false', async () => {
    const result = await runTool(listDirectoryTool, { path: 'nope' });
    expect(result.ok).toBe(false);
  });

  it('路径越界被拒绝', async () => {
    const result = await runTool(listDirectoryTool, { path: '..' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('越界');
  });
});

describe('search_content', () => {
  it('按子串命中，返回 相对路径:行号:文本', async () => {
    write('a.txt', '第一行\n这里有 bug 问题\n第三行');
    const result = await runTool(searchContentTool, { pattern: 'bug' });
    expect(result.ok).toBe(true);
    const data = result.data as { hits: Array<{ file: string; line: number; text: string }> };
    expect(data.hits).toEqual([{ file: 'a.txt', line: 2, text: '这里有 bug 问题' }]);
  });

  it('带 BOM 文件的首行可被搜索到（BOM 已剥离）', async () => {
    write('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('目标内容\n')]));
    const result = await runTool(searchContentTool, { pattern: '目标内容' });
    expect(result.ok).toBe(true);
    const data = result.data as { hits: Array<{ file: string; line: number; text: string }> };
    expect(data.hits).toEqual([{ file: 'bom.txt', line: 1, text: '目标内容' }]);
  });

  it('默认不区分大小写，caseSensitive: true 区分', async () => {
    write('a.txt', 'Fix Bug here');
    const loose = await runTool(searchContentTool, { pattern: 'bug' });
    const looseData = loose.data as { hits: Array<{ file: string; line: number; text: string }> };
    expect(looseData.hits).toHaveLength(1);

    const strict = await runTool(searchContentTool, { pattern: 'Bug', caseSensitive: true });
    const strictData = strict.data as { hits: Array<{ file: string; line: number; text: string }> };
    expect(strictData.hits).toHaveLength(1);

    const miss = await runTool(searchContentTool, { pattern: 'BUG', caseSensitive: true });
    const missData = miss.data as { hits: Array<{ file: string; line: number; text: string }> };
    expect(missData.hits).toHaveLength(0);
  });

  it('递归搜索子目录，返回相对路径', async () => {
    write('sub/deep.txt', 'needle here');
    const result = await runTool(searchContentTool, { pattern: 'needle' });
    const data = result.data as { hits: Array<{ file: string; line: number; text: string }> };
    expect(data.hits).toEqual([
      { file: path.join('sub', 'deep.txt'), line: 1, text: 'needle here' },
    ]);
  });

  it('跳过 node_modules 等依赖目录', async () => {
    write('node_modules/pkg/index.js', 'SECRET_PATTERN inside');
    write('src/main.js', 'SECRET_PATTERN visible');
    const result = await runTool(searchContentTool, { pattern: 'SECRET_PATTERN' });
    const data = result.data as { hits: Array<{ file: string; line: number; text: string }> };
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]?.file).toBe(path.join('src', 'main.js'));
  });

  it('跳过二进制文件（含 NUL 字节）', async () => {
    write('bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x78]));
    write('ok.txt', 'text 0x78 marker');
    const result = await runTool(searchContentTool, { pattern: 'marker' });
    const data = result.data as {
      hits: Array<{ file: string; line: number; text: string }>;
      skippedBinary: number;
    };
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]?.file).toBe('ok.txt');
    expect(data.skippedBinary).toBe(1);
  });

  it('命中数封顶并标记 truncated', async () => {
    const many = Array.from({ length: MAX_SEARCH_RESULTS + 50 }, () => 'hit line').join('\n');
    write('many.txt', many);
    const result = await runTool(searchContentTool, { pattern: 'hit' });
    const data = result.data as {
      hits: Array<{ file: string; line: number; text: string }>;
      truncated: boolean;
    };
    expect(data.hits).toHaveLength(MAX_SEARCH_RESULTS);
    expect(data.truncated).toBe(true);
  });

  it('未命中返回空列表', async () => {
    write('a.txt', 'nothing here');
    const result = await runTool(searchContentTool, { pattern: 'zzz-不存在' });
    const data = result.data as { hits: unknown[] };
    expect(data.hits).toHaveLength(0);
  });

  it('跳过 .env 敏感文件（安全加固）', async () => {
    write('.env', 'DEEPSEEK_API_KEY=secret-value-987654321');
    write('.env.local', 'DATABASE_URL=secret-value-local-123');
    write('ok.txt', 'secret-value-987654321 visible');
    const result = await runTool(searchContentTool, { pattern: 'secret-value' });
    const data = result.data as { hits: Array<{ file: string }> };
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]?.file).toBe('ok.txt');
  });

  it('同目录多文件并发扫描：命中完整且保序', async () => {
    // readdir 在不同平台（ext4/NTFS）的默认顺序不同，这里按字母序断言以保证跨平台一致
    write('b.txt', 'first hit');
    write('a.txt', 'second hit');
    write('c.txt', 'no match here');
    const result = await runTool(searchContentTool, { pattern: 'hit' });
    const data = result.data as { hits: Array<{ file: string }> };
    expect(data.hits.map((h) => h.file).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('同目录文件数超过并发上限：分片扫描命中完整不遗漏', async () => {
    // SEARCH_CONCURRENCY = 32：写 80 个文件（40 个命中），验证分片合并不丢命中
    for (let i = 0; i < 80; i += 1) {
      write(`f${String(i).padStart(3, '0')}.txt`, i % 2 === 0 ? 'needle here' : 'no match');
    }
    const result = await runTool(searchContentTool, { pattern: 'needle' });
    const data = result.data as { hits: Array<{ file: string }> };
    expect(data.hits).toHaveLength(40);
    // 文件路径齐全（无遗漏）
    const files = new Set(data.hits.map((h) => h.file));
    for (let i = 0; i < 80; i += 2) {
      expect(files.has(`f${String(i).padStart(3, '0')}.txt`)).toBe(true);
    }
    // 保序：按 readdir 顺序（NTFS 字母序）排列，即 f000, f002, f004…
    expect(data.hits.map((h) => h.file)).toEqual(
      Array.from({ length: 40 }, (_, i) => `f${String(i * 2).padStart(3, '0')}.txt`),
    );
  });

  it('起始路径越界被拒绝', async () => {
    const result = await runTool(searchContentTool, { pattern: 'x', path: '..' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('越界');
  });
});

describe('ToolRegistry', () => {
  it('注册、查找、列举', () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool).register(searchContentTool);
    expect(registry.get('read_file')?.name).toBe('read_file');
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.list().map((t) => t.name)).toEqual(['read_file', 'search_content']);
    expect(registry.list().every((t) => t.parallelSafe === true)).toBe(true);
  });

  it('重复注册抛错', () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    expect(() => registry.register(readFileTool)).toThrow('重复注册');
  });

  it('run 分发：校验失败返回 ok:false 且不执行', async () => {
    const registry = new ToolRegistry().register(readFileTool);
    const result = await registry.run('read_file', {}, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('参数校验失败');
  });

  it('run 分发：未知工具返回 ok:false', async () => {
    const registry = new ToolRegistry();
    const result = await registry.run('not_a_tool', {}, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('未知工具');
  });

  it('run 分发：执行异常被捕获转为 ok:false', async () => {
    const boom: ToolSpec = {
      name: 'boom',
      description: '测试用',
      parameters: z.object({}),
      parallelSafe: false,
      execute: () => {
        throw new Error('执行爆炸');
      },
    };
    const registry = new ToolRegistry().register(boom);
    const result = await registry.run('boom', {}, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('执行爆炸');
  });
});
