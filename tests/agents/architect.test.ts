/**
 * Architect Agent 测试（v3.0 M3 / T3.1）。
 *
 * 覆盖验收标准：
 * - 输入需求 → 输出 ArchitectSpec（接口定义 + 文件结构 + 约束条件）；
 * - spec 为结构化 JSON，可被 Coder 直接消费（接口签名 + 文件依赖 + 约束）；
 * - spec 输出前走审批流（onSpec 确认执行 / 拒绝抛错不产出工件）；
 * - 无 spec（非法 JSON / 结构不符 / 空设计）→ 明确抛错，不产出空工件。
 */
import { describe, expect, it } from 'vitest';
import { ArchitectAgent, generateArchitectSpec, parseArchitectSpec } from '../../src/agents';
import type { ChatCompletionChunk, ModelClient } from '../../src/model/client';
import type { AgentContext } from '../../src/orchestrator';

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
    taskId: 'task-architect',
    parentTaskId: 'task-0',
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

/** 合法 spec 的 JSON 文本。 */
const SPEC_JSON = JSON.stringify({
  requirement: '实现一个 TODO 应用',
  interfaces: [
    {
      file: 'src/todo.ts',
      responsibility: 'TODO 核心逻辑',
      exports: [
        {
          name: 'createTodo',
          signature: 'export function createTodo(title: string): Todo',
          description: '创建待办',
        },
      ],
    },
  ],
  files: [
    { path: 'src/todo.ts', purpose: '核心逻辑', dependsOn: ['src/types.ts'] },
    { path: 'src/types.ts', purpose: '类型定义' },
  ],
  constraints: ['使用 TypeScript strict 模式', '不引入新依赖'],
  notes: ['TODO 接口需支持完成/删除'],
});

// ── parseArchitectSpec ────────────────────────────────────────

describe('parseArchitectSpec（模型输出解析）', () => {
  it('解析合法 JSON（接口定义 + 文件结构 + 约束条件）', () => {
    const spec = parseArchitectSpec(SPEC_JSON);
    expect(spec.requirement).toBe('实现一个 TODO 应用');
    expect(spec.interfaces).toHaveLength(1);
    expect(spec.interfaces[0]?.exports[0]?.signature).toContain('createTodo');
    expect(spec.files).toHaveLength(2);
    expect(spec.files[0]?.dependsOn).toEqual(['src/types.ts']);
    expect(spec.constraints).toContain('使用 TypeScript strict 模式');
  });

  it('容忍 ```json 围栏包裹', () => {
    const text = `\`\`\`json\n${SPEC_JSON}\n\`\`\``;
    const spec = parseArchitectSpec(text);
    expect(spec.files).toHaveLength(2);
  });

  it('缺少 constraints/interfaces 时默认空数组（schema default）', () => {
    const text = JSON.stringify({
      requirement: 'x',
      files: [{ path: 'src/a.ts', purpose: 'p' }],
    });
    const spec = parseArchitectSpec(text);
    expect(spec.constraints).toEqual([]);
    expect(spec.interfaces).toEqual([]);
  });

  it('非法 JSON 抛中文错误（含原文片段）', () => {
    expect(() => parseArchitectSpec('{not json')).toThrow(/架构设计失败.*不是合法 JSON/s);
  });

  it('结构不符协议抛错（缺 requirement）', () => {
    const text = JSON.stringify({ files: [{ path: 'src/a.ts', purpose: 'p' }] });
    expect(() => parseArchitectSpec(text)).toThrow(/结构不符合协议/);
  });

  it('空设计（无任何文件）→ 明确抛错，不产出空 spec', () => {
    const text = JSON.stringify({ requirement: 'x', files: [], interfaces: [] });
    expect(() => parseArchitectSpec(text)).toThrow(/空设计/);
  });
});

// ── generateArchitectSpec ─────────────────────────────────────

describe('generateArchitectSpec（模型生成）', () => {
  it('流式收集模型输出并解析为 spec', async () => {
    // 分两段模拟流式
    const client = new FakeModelClient([SPEC_JSON.slice(0, 40), SPEC_JSON.slice(40)]);
    const spec = await generateArchitectSpec(client, 'fake-model', '做一个 TODO', makeContext());
    expect(spec.files).toHaveLength(2);
    expect(spec.constraints[0]).toContain('strict');
  });
});

// ── ArchitectAgent ────────────────────────────────────────────

describe('ArchitectAgent（标准 Agent 契约）', () => {
  function makeAgent(onSpec?: (spec: { files: unknown[] }) => Promise<boolean>): ArchitectAgent {
    return new ArchitectAgent({
      client: new FakeModelClient([SPEC_JSON]),
      model: 'fake',
      onSpec,
    });
  }

  it('def 契约：name=architect，输入 description / 输出 ArchitectSpec，权限最小只读', () => {
    const agent = makeAgent();
    expect(agent.def.name).toBe('architect');
    expect(agent.def.version).toBe('1.0.0');
    // 权限 fail-closed：只读工具，不含写/执行
    const toolNames = agent.def.permissions.map((p) => p.tool);
    expect(toolNames).toEqual(['read_file', 'list_directory', 'search_content']);
  });

  it('execute：生成 spec → 审批确认 → 返回结构化 spec（可被 Coder 消费）', async () => {
    let seen: unknown;
    const agent = makeAgent(async (spec) => {
      seen = spec;
      return true;
    });
    const spec = await agent.execute({ description: '实现 TODO 应用' }, makeContext());
    expect(seen).toBeDefined();
    expect(spec.files).toHaveLength(2);
    expect(spec.interfaces[0]?.exports[0]?.signature).toContain('export function');
  });

  it('审批拒绝 → 抛错（不产出工件）', async () => {
    const agent = makeAgent(async () => false);
    await expect(agent.execute({ description: '需求' }, makeContext())).rejects.toThrow(
      /未确认设计方向/,
    );
  });

  it('无 spec（模型输出无效）→ 抛错，不产出空工件', async () => {
    const agent = new ArchitectAgent({
      client: new FakeModelClient(['不是 JSON']),
      model: 'fake',
    });
    await expect(agent.execute({ description: '需求' }, makeContext())).rejects.toThrow(
      /架构设计失败/,
    );
  });
});
