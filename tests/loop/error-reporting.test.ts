/**
 * 结构化错误增强测试（v3.1 M4 / T4.2）。
 *
 * 覆盖：
 * - read 工具错误分类：PATH_OUTSIDE_SANDBOX / FILE_NOT_FOUND / DIR_NOT_FOUND / SENSITIVE_FILE（各带中文 suggestion）；
 * - edit 工具错误分类：PATH_OUTSIDE_SANDBOX / SEARCH_NOT_FOUND / EDIT_REJECTED（各带中文 suggestion）；
 * - shell 工具错误分类：SHELL_REJECTED / EXIT_1（各带 suggestion）；
 * - knowledge 工具错误分类：ENTITY_NOT_FOUND（带 suggestion）；
 * - ToolRepairError 渲染：含 suggestion 时展示 💡 行；不含 code/suggestion 的旧结构仍正常渲染（向后兼容）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { KnowledgeStore } from '../../src/knowledge/store';
import { runLoop } from '../../src/loop/loop';
import type { ToolCall } from '../../src/loop/types';
import type { ChatCompletionChunk, ModelClient, StreamChatParams } from '../../src/model/client';
import { editFileTool } from '../../src/tools/edit';
import { ToolErrorCode } from '../../src/tools/error-codes';
import { createKnowledgeTools } from '../../src/tools/knowledge';
import { readFileTool } from '../../src/tools/read';
import type { ToolContext, ToolResult, ToolSpec } from '../../src/tools/registry';
import { ToolRegistry } from '../../src/tools/registry';
import { shellTool } from '../../src/tools/shell';

const model = 'deepseek-v4-flash';

/** 脚本式 mock 模型：按序消费回复；tool_calls 拆两片覆盖增量拼接。 */
class FakeModel implements ModelClient {
  constructor(private readonly script: Array<{ content?: string; toolCalls?: ToolCall[] }>) {}

  async *streamChat(_params: StreamChatParams): AsyncGenerator<ChatCompletionChunk> {
    const step = this.script.shift();
    if (step === undefined) {
      throw new Error('FakeModel 脚本耗尽');
    }
    if (step.content !== undefined) {
      yield {
        id: 'fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [{ index: 0, delta: { content: step.content }, finish_reason: null }],
        usage: null,
      };
    }
    let index = 0;
    for (const tc of step.toolCalls ?? []) {
      yield {
        id: 'fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [
          {
            index,
            delta: {
              tool_calls: [
                { index, id: tc.id, function: { name: tc.name, arguments: tc.arguments } },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      };
      index += 1;
    }
  }
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, arguments: JSON.stringify(args) };
}

let tmp: string;
let ctx: ToolContext;
let registry: ToolRegistry;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'error-report-'));
  ctx = { cwd: tmp, requestApproval: vi.fn(async () => true) };
  registry = new ToolRegistry().register(readFileTool).register(editFileTool);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 断言错误结果带 code + 非空 suggestion。 */
function expectCoded(result: ToolResult, code: string): void {
  expect(result.ok).toBe(false);
  expect(result.code).toBe(code);
  expect(result.suggestion).toBeDefined();
  expect(result.suggestion?.length).toBeGreaterThan(0);
}

// ── read 工具错误分类 ─────────────────────────────────────────

describe('read 工具错误分类（T4.1）', () => {
  it('read_file 路径越界 → PATH_OUTSIDE_SANDBOX + suggestion', async () => {
    const result = await readFileTool.execute({ path: '../secret.txt' }, ctx);
    expectCoded(result, ToolErrorCode.PATH_OUTSIDE_SANDBOX);
    expect(result.suggestion).toContain('相对路径');
  });

  it('read_file 文件不存在 → FILE_NOT_FOUND + suggestion', async () => {
    const result = await readFileTool.execute({ path: 'missing.txt' }, ctx);
    expectCoded(result, ToolErrorCode.FILE_NOT_FOUND);
    expect(result.suggestion).toContain('list_directory');
  });

  it('read_file 目标为目录 → DIR_NOT_FOUND + suggestion', async () => {
    mkdirSync(path.join(tmp, 'adir'), { recursive: true });
    const result = await readFileTool.execute({ path: 'adir' }, ctx);
    expectCoded(result, ToolErrorCode.DIR_NOT_FOUND);
    expect(result.suggestion).toContain('目录');
  });

  it('read_file 敏感文件 → SENSITIVE_FILE + suggestion（不可修复）', async () => {
    writeFileSync(path.join(tmp, '.env'), 'SECRET=1', 'utf8');
    const result = await readFileTool.execute({ path: '.env' }, ctx);
    expectCoded(result, ToolErrorCode.SENSITIVE_FILE);
    expect(result.repairable).toBe(false);
  });

  it('list_directory 目录不存在 → DIR_NOT_FOUND + suggestion', async () => {
    const { listDirectoryTool } = await import('../../src/tools/read');
    const result = await listDirectoryTool.execute({ path: 'nope' }, ctx);
    expectCoded(result, ToolErrorCode.DIR_NOT_FOUND);
  });
});

// ── edit 工具错误分类 ─────────────────────────────────────────

describe('edit 工具错误分类（T4.1）', () => {
  it('edit_file 路径越界 → PATH_OUTSIDE_SANDBOX + suggestion', async () => {
    const result = await editFileTool.execute({ path: '../x.ts', search: 'a', replace: 'b' }, ctx);
    expectCoded(result, ToolErrorCode.PATH_OUTSIDE_SANDBOX);
  });

  it('edit_file SEARCH 未找到 → SEARCH_NOT_FOUND + suggestion', async () => {
    writeFileSync(path.join(tmp, 'a.ts'), 'hello', 'utf8');
    const result = await editFileTool.execute(
      { path: 'a.ts', search: 'not-there', replace: 'x' },
      ctx,
    );
    expectCoded(result, ToolErrorCode.SEARCH_NOT_FOUND);
    expect(result.suggestion).toContain('read_file');
  });

  it('edit_file 审批拒绝 → EDIT_REJECTED + suggestion（不可修复）', async () => {
    writeFileSync(path.join(tmp, 'a.ts'), 'hello', 'utf8');
    const rejectCtx: ToolContext = { cwd: tmp, requestApproval: async () => false };
    const result = await editFileTool.execute(
      { path: 'a.ts', search: 'hello', replace: 'world' },
      rejectCtx,
    );
    expectCoded(result, ToolErrorCode.EDIT_REJECTED);
    expect(result.repairable).toBe(false);
  });

  it('planEdit SEARCH 不唯一 → SEARCH_NOT_UNIQUE（错误对象携带 code）', async () => {
    const { planEdit } = await import('../../src/tools/edit');
    try {
      planEdit('a\nb\na', 'a', 'x');
      expect.unreachable('应抛出 EditPlanError');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ToolErrorCode.SEARCH_NOT_UNIQUE);
    }
  });
});

// ── shell 工具错误分类 ────────────────────────────────────────

describe('shell 工具错误分类（T4.1）', () => {
  it('审批拒绝 → SHELL_REJECTED + suggestion（不可修复）', async () => {
    const rejectCtx: ToolContext = { cwd: tmp, requestApproval: async () => false };
    const result = await shellTool.execute({ command: 'git push' }, rejectCtx);
    expectCoded(result, ToolErrorCode.SHELL_REJECTED);
    expect(result.repairable).toBe(false);
  });

  it('命令退出码非 0 → EXIT_1 + suggestion', async () => {
    const result = await shellTool.execute(
      { command: 'node -e "process.exit(1)"', timeoutMs: 10_000 },
      { ...ctx, requestApproval: async () => true },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('EXIT_1');
    expect(result.suggestion).toBeDefined();
    expect(result.suggestion?.length).toBeGreaterThan(0);
  }, 20_000);
});

// ── knowledge 工具错误分类 ────────────────────────────────────

describe('knowledge 工具错误分类（T4.1）', () => {
  it('open_nodes 实体不存在 → ENTITY_NOT_FOUND + suggestion', async () => {
    const store = new KnowledgeStore(tmp);
    const tools = createKnowledgeTools(store);
    const openTool = tools.find((t) => t.name === 'knowledge_open_nodes');
    expect(openTool).toBeDefined();
    const result = await openTool?.execute({ names: ['ghost-entity'] }, ctx);
    expect(result?.ok).toBe(false);
    expect(result?.code).toBe(ToolErrorCode.ENTITY_NOT_FOUND);
    expect(result?.suggestion).toContain('knowledge_search');
  });

  it('open_nodes 部分存在 → 正常返回（不误报 ENTITY_NOT_FOUND）', async () => {
    const store = new KnowledgeStore(tmp);
    store.createEntities([{ name: 'exist', entityType: 't', observations: [] }]);
    const tools = createKnowledgeTools(store);
    const openTool = tools.find((t) => t.name === 'knowledge_open_nodes');
    const result = await openTool?.execute({ names: ['exist', 'ghost'] }, ctx);
    expect(result?.ok).toBe(true);
    expect(result).toBeDefined();
    if (result !== undefined && result.data !== undefined) {
      expect((result.data as { entities: unknown[] }).entities).toHaveLength(1);
    }
  });
});

// ── ToolRepairError 渲染兼容 ───────────────────────────────────

describe('ToolRepairError 渲染兼容（T4.2）', () => {
  /** 连续 3 次可修复失败（read_file 不存在）→ 触发 ToolRepairError（MAX_REPAIRS=2）。 */
  function failingScript(calls: ToolCall[]): Array<{ toolCalls: ToolCall[] }> {
    return [1, 2, 3].map(() => ({ toolCalls: calls }));
  }

  it('含 suggestion 时渲染 💡 建议行', async () => {
    const calls = [toolCall('read_file', { path: 'missing.txt' })];
    const client = new FakeModel(failingScript(calls));
    let thrown: Error | undefined;
    try {
      await runLoop({ model, client, registry, ctx }, [], '读取文件');
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.name).toBe('ToolRepairError');
    // 结构化错误（FILE_NOT_FOUND 带 suggestion）应在失败详情行渲染缩进 💡 建议
    // （6 空格缩进区别于静态建议区「💡 建议：」）
    expect(thrown?.message).toContain('       💡');
    expect(thrown?.message).toContain('list_directory');
  });

  it('向后兼容：不含 code/suggestion 的旧错误结构不渲染 💡 行', async () => {
    // 自定义旧结构工具：只返回 { ok:false, error }，无 code/suggestion
    const legacyTool: ToolSpec = {
      name: 'legacy_fail',
      description: '旧结构失败工具',
      parameters: z.object({}),
      parallelSafe: true,
      execute: async (): Promise<ToolResult> => ({ ok: false, error: '旧结构错误（无建议）' }),
    };
    const localRegistry = new ToolRegistry().register(legacyTool);
    const client = new FakeModel(
      [1, 2, 3].map(() => ({ toolCalls: [toolCall('legacy_fail', {})] })),
    );
    let thrown: Error | undefined;
    try {
      await runLoop({ model, client, registry: localRegistry, ctx }, [], '触发旧结构失败');
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.name).toBe('ToolRepairError');
    // 旧结构错误：失败详情行不渲染 6 空格缩进的 💡 建议（ToolRepairError 底部
    // 静态「💡 建议：」区总是存在，只断言详情行级别的缩进建议不出现）
    expect(thrown?.message).toContain('旧结构错误（无建议）');
    expect(thrown?.message).not.toContain('\n       💡');
  });

  it('registry.run 未知工具 → UNKNOWN_TOOL + suggestion（不可修复）', async () => {
    const result = await registry.run('no_such_tool', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNKNOWN_TOOL');
    expect(result.repairable).toBe(false);
    expect(result.suggestion).toContain('read_file');
  });
});
