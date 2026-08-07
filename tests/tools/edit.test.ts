import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editFileTool } from '../../src/tools/edit';
import type { ApprovalRequest, ToolContext, ToolResult } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';

let tmp: string;
let ctx: ToolContext;
let registry: ToolRegistry;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
  ctx = { cwd: tmp, requestApproval: vi.fn(async () => true) };
  registry = new ToolRegistry().register(editFileTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(tmp, rel);
  writeFileSync(full, content);
}

function read(rel: string): string {
  return readFileSync(path.join(tmp, rel), 'utf8');
}

async function edit(
  args: { path: string; search: string; replace: string },
  approval?: (request: ApprovalRequest) => Promise<boolean> | boolean,
): Promise<ToolResult> {
  const runCtx: ToolContext =
    approval === undefined ? ctx : { cwd: tmp, requestApproval: approval };
  return registry.run('edit_file', args, runCtx);
}

describe('edit_file 基础编辑', () => {
  it('单行替换成功，diff 含 hunk 头与 -/+ 行，文件已更新', async () => {
    write('a.txt', 'hello\nworld\n');
    const result = await edit({ path: 'a.txt', search: 'world', replace: '世界' });

    expect(result.ok).toBe(true);
    const data = result.data as { diff: string };
    expect(data.diff).toContain('@@ -2,1 +2,1 @@');
    expect(data.diff).toContain('-world');
    expect(data.diff).toContain('+世界');
    expect(read('a.txt')).toBe('hello\n世界\n');
  });

  it('多行 SEARCH/REPLACE', async () => {
    write('a.txt', '第一行\n第二行\n第三行\n');
    const result = await edit({ path: 'a.txt', search: '第一行\n第二行', replace: '甲\n乙' });
    expect(result.ok).toBe(true);
    expect(read('a.txt')).toBe('甲\n乙\n第三行\n');
    const data = result.data as { diff: string };
    expect(data.diff).toContain('@@ -1,2 +1,2 @@');
    expect(data.diff).toContain('-第一行');
    expect(data.diff).toContain('+甲');
  });

  it('替换为空串（删除）', async () => {
    write('a.txt', 'keep\ndelete me\nkeep2\n');
    const result = await edit({ path: 'a.txt', search: 'delete me\n', replace: '' });
    expect(result.ok).toBe(true);
    expect(read('a.txt')).toBe('keep\nkeep2\n');
  });

  it('中文与换行混合替换（UTF-8 安全）', async () => {
    write('a.txt', '你好世界\n');
    const result = await edit({ path: 'a.txt', search: '你好', replace: 'hello' });
    expect(result.ok).toBe(true);
    expect(read('a.txt')).toBe('hello世界\n');
  });

  it('diff 带前后上下文行', async () => {
    write('a.txt', '1\n2\n3\n4\n5\n');
    const result = await edit({ path: 'a.txt', search: '3', replace: '三' });
    const data = result.data as { diff: string };
    expect(data.diff).toContain(' 2');
    expect(data.diff).toContain('-3');
    expect(data.diff).toContain('+三');
    expect(data.diff).toContain(' 4');
  });

  it('新文件顶层创建（search 为空）', async () => {
    const result = await edit({ path: 'new.txt', search: '', replace: '内容\n第二行' });
    expect(result.ok).toBe(true);
    expect(read('new.txt')).toBe('内容\n第二行');
    const data = result.data as { diff: string };
    expect(data.diff).toContain('@@ +1,2 @@');
    expect(data.diff).toContain('+内容');
  });
});

describe('edit_file 拒绝路径', () => {
  it('SEARCH 未找到 → ok:false，文件不变', async () => {
    write('a.txt', '原文');
    const result = await edit({ path: 'a.txt', search: '不存在的内容', replace: 'x' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('未在文件中找到');
    expect(read('a.txt')).toBe('原文');
  });

  it('SEARCH 出现多次 → ok:false，文件不变', async () => {
    write('a.txt', '重复\n重复\n');
    const result = await edit({ path: 'a.txt', search: '重复', replace: 'x' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('出现多次');
    expect(read('a.txt')).toBe('重复\n重复\n');
  });

  it('文件不存在且 search 非空 → ok:false', async () => {
    const result = await edit({ path: 'missing.txt', search: 'x', replace: 'y' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('文件不存在');
  });

  it('空 search 但文件已存在 → ok:false，文件不变', async () => {
    write('a.txt', '原有内容');
    const result = await edit({ path: 'a.txt', search: '', replace: '覆盖' });
    expect(result.ok).toBe(false);
    expect(read('a.txt')).toBe('原有内容');
  });

  it('路径越界 → ok:false', async () => {
    const result = await edit({ path: '..', search: 'x', replace: 'y' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('越界');
  });
});

describe('edit_file 审批门控', () => {
  it('审批拒绝 → ok:false 且不落盘（核心断言）', async () => {
    write('a.txt', '原始内容');
    const result = await edit(
      { path: 'a.txt', search: '原始', replace: '篡改' },
      async () => false,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('拒绝');
    expect(read('a.txt')).toBe('原始内容');
  });

  it('新建文件时审批拒绝同样不落盘', async () => {
    const result = await edit({ path: 'new.txt', search: '', replace: '内容' }, async () => false);
    expect(result.ok).toBe(false);
    expect(() => read('new.txt')).toThrow();
  });

  it('审批回调未配置 → fail-closed 拒绝，不落盘', async () => {
    write('a.txt', '原文');
    const bare = new ToolRegistry().register(editFileTool);
    const result = await bare.run(
      'edit_file',
      { path: 'a.txt', search: '原文', replace: '改' },
      { cwd: tmp },
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('拒绝');
    expect(read('a.txt')).toBe('原文');
  });

  it('审批请求内容正确：kind=edit、summary 含路径、detail 为 diff', async () => {
    write('a.txt', 'old line\n');
    const spy = vi.fn(async (_request: ApprovalRequest) => true);
    await edit({ path: 'a.txt', search: 'old line', replace: 'new line' }, spy);

    const firstCall = spy.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('测试夹具：审批回调未被调用');
    }
    const request = firstCall[0];
    expect(request.kind).toBe('edit');
    expect(request.summary).toContain('a.txt');
    expect(request.detail).toContain('-old line');
    expect(request.detail).toContain('+new line');
  });

  it('审批未通过前文件内容保持不变（延迟审批）', async () => {
    write('a.txt', '原文');
    let resolveFn: (v: boolean) => void = () => {};
    const pending = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });
    const runPromise = registry.run(
      'edit_file',
      { path: 'a.txt', search: '原文', replace: '改' },
      { cwd: tmp, requestApproval: async () => pending },
    );
    // 审批悬而未决时，文件不应被写入
    expect(read('a.txt')).toBe('原文');
    resolveFn(true);
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(read('a.txt')).toBe('改');
  });

  it('parallelSafe 为 false（写操作不可并行）', () => {
    expect(editFileTool.parallelSafe).toBe(false);
  });
});
