/**
 * Coder Agent 测试（v3.0 M3 / T3.2）。
 *
 * 覆盖验收标准：
 * - 按 ArchitectSpec 编码实现（多文件输出 + 审批流后写盘）；
 * - 接收 Reviewer 问题列表（🔴🟡🟢）→ 自动生成修复方案；
 * - 修复前用户确认（审批流），确认后写盘；
 * - 文件修改通过 CoderFileWriter 登记（T3.6 事务接入点）；
 * - 复用 v2.0 edit 工具 SEARCH/REPLACE 语义（diffForWrite 基于 planEdit）。
 */
import { describe, expect, it } from 'vitest';
import type { ArchitectSpec } from '../../src/agents';
import {
  CoderAgent,
  type CoderFile,
  type CoderFileWriter,
  diffForWrite,
  generateFix,
  generateImplementation,
  parseCoderOutput,
} from '../../src/agents';
import type { ChatCompletionChunk, ModelClient } from '../../src/model/client';
import type { AgentContext } from '../../src/orchestrator';
import type { ReviewIssue } from '../../src/reviewer';

// ── Fake 模型客户端 ───────────────────────────────────────────

/** 流式返回预设文本的 Fake 模型客户端。 */
class FakeModelClient implements ModelClient {
  private readonly replies: string[];

  constructor(replies: string[]) {
    this.replies = replies;
  }

  async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
    for (const text of this.replies) {
      yield {
        id: 'fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
    }
  }
}

// ── 测试辅助 ──────────────────────────────────────────────────

/** 构造一个最小 AgentContext。 */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess-1',
    taskId: 'task-coder',
    parentTaskId: 'task-0',
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

/** 合法文件集合（Coder 输出/修复基线的类型安全常量）。 */
const FILES: CoderFile[] = [
  {
    path: 'src/todo.ts',
    content: 'export function createTodo(title: string): Todo { return { title }; }',
  },
  { path: 'src/types.ts', content: 'export interface Todo { title: string; done: boolean }' },
];

/** 合法 CoderOutput JSON 文本。 */
const OUTPUT_JSON = JSON.stringify({ files: FILES });

/** 合法 ArchitectSpec（T3.1 输出，供 Coder 实现模式消费）。 */
const SPEC: ArchitectSpec = {
  requirement: '实现一个 TODO 应用',
  interfaces: [
    {
      file: 'src/todo.ts',
      responsibility: 'TODO 核心逻辑',
      exports: [
        { name: 'createTodo', signature: 'export function createTodo(title: string): Todo' },
      ],
    },
  ],
  files: [
    { path: 'src/todo.ts', purpose: '核心逻辑', dependsOn: ['src/types.ts'] },
    { path: 'src/types.ts', purpose: '类型定义' },
  ],
  constraints: ['使用 TypeScript strict 模式'],
};

/** 内存文件写入器（记录写入，验证写盘行为）。 */
class MemoryWriter implements CoderFileWriter {
  readonly written = new Map<string, string>();

  async write(relPath: string, content: string): Promise<void> {
    this.written.set(relPath, content);
  }
}

// ── parseCoderOutput ──────────────────────────────────────────

describe('parseCoderOutput（模型输出解析）', () => {
  it('解析合法 JSON（多文件 path + content）', () => {
    const output = parseCoderOutput(OUTPUT_JSON);
    expect(output.files).toHaveLength(2);
    expect(output.files[0]?.path).toBe('src/todo.ts');
    expect(output.files[0]?.content).toContain('createTodo');
  });

  it('容忍 ```json 围栏包裹', () => {
    const output = parseCoderOutput(`\`\`\`json\n${OUTPUT_JSON}\n\`\`\``);
    expect(output.files).toHaveLength(2);
  });

  it('空文件集合（无 files）→ 抛错', () => {
    expect(() => parseCoderOutput(JSON.stringify({ files: [] }))).toThrow(/至少产出 1 个文件/);
  });

  it('非法 JSON 抛中文错误（含原文片段）', () => {
    expect(() => parseCoderOutput('{not json')).toThrow(/代码生成失败.*不是合法 JSON/s);
  });
});

// ── generateImplementation / generateFix ──────────────────────

describe('generateImplementation / generateFix（模型生成）', () => {
  it('按 spec 生成实现代码（流式收集）', async () => {
    const client = new FakeModelClient([OUTPUT_JSON.slice(0, 40), OUTPUT_JSON.slice(40)]);
    const output = await generateImplementation(client, 'fake', SPEC, makeContext());
    expect(output.files).toHaveLength(2);
    expect(output.files[0]?.path).toBe('src/todo.ts');
  });

  it('接收 Reviewer 问题列表 → 生成修复方案', async () => {
    const client = new FakeModelClient([OUTPUT_JSON]);
    const issues: ReviewIssue[] = [
      {
        dimension: 'types',
        severity: 'critical',
        file: 'src/todo.ts',
        title: '缺少 done 字段',
        description: 'Todo 接口缺少 done 字段',
      },
      {
        dimension: 'style',
        severity: 'suggestion',
        file: 'src/types.ts',
        title: '建议加注释',
        description: '可选择性添加',
      },
    ];
    const output = await generateFix(client, 'fake', FILES, issues, makeContext());
    expect(output.files).toHaveLength(2);
  });
});

// ── diffForWrite（复用 edit 工具 SEARCH/REPLACE 语义）────────

describe('diffForWrite（基于 planEdit 的 SEARCH/REPLACE diff）', () => {
  it('新文件（original 为空）→ 创建 diff（全 + 行）', () => {
    const diff = diffForWrite('', 'export const x = 1;\n');
    expect(diff).toContain('+export const x = 1;');
  });

  it('修改文件 → 替换 diff 包含 +/- 行', () => {
    const diff = diffForWrite('const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst b = 3;\n');
    expect(diff).toContain('-const b = 2;');
    expect(diff).toContain('+const b = 3;');
  });
});

// ── CoderAgent ────────────────────────────────────────────────

describe('CoderAgent（标准 Agent 契约）', () => {
  it('def 契约：name=coder，权限 = edit_file（写文件最小权限）', () => {
    const agent = new CoderAgent({
      client: new FakeModelClient([OUTPUT_JSON]),
      model: 'fake',
      writer: new MemoryWriter(),
    });
    expect(agent.def.name).toBe('coder');
    expect(agent.def.version).toBe('1.0.0');
    expect(agent.def.permissions.map((p) => p.tool)).toEqual(['edit_file']);
  });

  it('实现模式：按 spec 生成 → 审批确认 → 写盘 → 返回文件集合', async () => {
    const writer = new MemoryWriter();
    let seenReason: string | undefined;
    let seenFiles: CoderFile[] = [];
    const agent = new CoderAgent({
      client: new FakeModelClient([OUTPUT_JSON]),
      model: 'fake',
      writer,
      onApproval: async (files, reason) => {
        seenFiles = files;
        seenReason = reason;
        return true;
      },
    });
    const output = await agent.execute({ description: '实现 TODO', spec: SPEC }, makeContext());
    expect(seenReason).toBe('implement');
    expect(seenFiles).toHaveLength(2);
    // 写盘：两个文件都写入
    expect(writer.written.has('src/todo.ts')).toBe(true);
    expect(writer.written.has('src/types.ts')).toBe(true);
    expect(writer.written.get('src/todo.ts')).toContain('createTodo');
    expect(output.files).toHaveLength(2);
  });

  it('审批拒绝 → 抛错且不写盘（fail-closed）', async () => {
    const writer = new MemoryWriter();
    const agent = new CoderAgent({
      client: new FakeModelClient([OUTPUT_JSON]),
      model: 'fake',
      writer,
      onApproval: async () => false,
    });
    await expect(agent.execute({ description: '需求', spec: SPEC }, makeContext())).rejects.toThrow(
      /未确认代码方案/,
    );
    expect(writer.written.size).toBe(0); // 未写盘
  });

  it('实现模式缺 spec → 抛错（不产出空工件）', async () => {
    const agent = new CoderAgent({
      client: new FakeModelClient([OUTPUT_JSON]),
      model: 'fake',
      writer: new MemoryWriter(),
    });
    await expect(agent.execute({ description: '需求' }, makeContext())).rejects.toThrow(
      /缺少 ArchitectSpec/,
    );
  });

  it('修复模式：接收 issues → 生成修复 → 审批 → 写盘', async () => {
    const writer = new MemoryWriter();
    let seenReason: string | undefined;
    const agent = new CoderAgent({
      client: new FakeModelClient([OUTPUT_JSON]),
      model: 'fake',
      writer,
      onApproval: async (_files, reason) => {
        seenReason = reason;
        return true;
      },
    });
    const issues: ReviewIssue[] = [
      {
        dimension: 'types',
        severity: 'critical',
        file: 'src/todo.ts',
        title: '缺字段',
        description: 'x',
      },
    ];
    const output = await agent.execute({ description: '修复', issues }, makeContext());
    expect(seenReason).toBe('fix');
    expect(writer.written.size).toBe(2);
    expect(output.files).toHaveLength(2);
  });

  it('模型输出无效 → 抛错不写盘', async () => {
    const writer = new MemoryWriter();
    const agent = new CoderAgent({
      client: new FakeModelClient(['不是 JSON']),
      model: 'fake',
      writer,
    });
    await expect(agent.execute({ description: '需求', spec: SPEC }, makeContext())).rejects.toThrow(
      /代码生成失败/,
    );
    expect(writer.written.size).toBe(0);
  });
});
