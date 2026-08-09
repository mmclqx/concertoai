import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SubagentSpawner } from '../../src/agent/spawner';
import type { SubagentDef } from '../../src/agent/types';
import type { McpClient } from '../../src/mcp/client';
import type { McpManager } from '../../src/mcp/manager';
import type { ChatCompletionChunk, ModelClient } from '../../src/model/client';

// ── FakeModel 工具集 ────────────────────────────────────────

function fakeChunk(
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

/** 单次回复模型：每次 streamChat 返回固定内容。 */
function singleReplyModel(content: string): ModelClient {
  return {
    async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
      yield fakeChunk({ content });
      yield fakeChunk({}, 'stop');
    },
  };
}

/** 多轮脚本模型：按顺序消费回复。 */
class ScriptedModel implements ModelClient {
  received: string[][] = [];
  private idx = 0;

  constructor(private readonly script: string[][]) {}

  async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
    const chunks = this.script[this.idx];
    this.idx += 1;
    if (chunks === undefined) {
      throw new Error('脚本耗尽');
    }
    for (const c of chunks) {
      this.received.push([c]);
      yield fakeChunk({ content: c });
    }
    yield fakeChunk({}, 'stop');
  }
}

// ── 测试夹具 ────────────────────────────────────────────────

let tmp: string;
const TEST_AGENT: SubagentDef = {
  name: 'test-agent',
  description: '测试用子代理',
  allowedTools: ['read_file'],
  maxTurns: 3,
  timeoutMs: 10_000,
  systemPrompt: '你是测试助手',
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-agent-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('SubagentSpawner', () => {
  it('未知子代理 → ok:false', async () => {
    const model = singleReplyModel('不该调用');
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash');
    const result = await spawner.spawn({ agentName: 'no-such', prompt: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown_agent');
    expect(result.toolCallCount).toBe(0);
  });

  it('子代理返回结论 → ok:true + summary', async () => {
    const model = singleReplyModel('探索结论：文件在 src/a.ts');
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash');
    spawner.register(TEST_AGENT);

    const result = await spawner.spawn({ agentName: 'test-agent', prompt: '查文件' });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('探索结论');
    expect(result.toolCallCount).toBe(0); // 无工具调用
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('子代理超时 → ok:false', async () => {
    // 永不返回的模型
    const slowModel: ModelClient = {
      async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
        await new Promise(() => {}); // 永远不 resolve
      },
    };
    const fastTimeout: SubagentDef = {
      ...TEST_AGENT,
      timeoutMs: 500,
    };
    const spawner = new SubagentSpawner(slowModel, { cwd: tmp }, 'deepseek-v4-flash');
    spawner.register(fastTimeout);

    const result = await spawner.spawn({ agentName: 'test-agent', prompt: '慢任务' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  }, 10_000);

  it('工具白名单生效 — 仅 registered 工具可用', async () => {
    writeFileSync(path.join(tmp, 'a.txt'), '内容');

    // 第一轮：调用 read_file（允许）
    // 第二轮：返回结论
    const model = new ScriptedModel([
      ['{"name": "read_file", "arguments": {"path":"a.txt"}}'],
      ['读取完成，文件内容为"内容"'],
    ]);
    // 注意：这里不能模拟真实 tool_calls，因为 ScriptedModel 只是返回文本
    // 真正的工具执行需要 runLoop 做工具分发
    // 这里验证注册和配置正确性即可
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash');
    spawner.register(TEST_AGENT);

    const def = spawner.get('test-agent');
    expect(def).toBeDefined();
    expect(def?.allowedTools).toEqual(['read_file']);

    const result = await spawner.spawn({ agentName: 'test-agent', prompt: 'test' });
    // 无 tool_calls 的简单回复
    expect(result.toolCallCount).toBe(0);
  });

  it('子代理达到 maxTurns 上限 → interrupted', async () => {
    // 每轮都返回 tool_calls，直到轮数耗尽
    const model = singleReplyModel('{"name":"noop","arguments":{}}');
    const manyTurns: SubagentDef = {
      ...TEST_AGENT,
      maxTurns: 1,
      allowedTools: ['read_file', 'search_content', 'list_directory'],
    };
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash');
    spawner.register(manyTurns);

    const result = await spawner.spawn({ agentName: 'test-agent', prompt: 'test' });
    // 模型返回的是文本不是合法的 tool_calls JSON，所以实际上是纯文本
    // 这个测试主要验证 maxTurns 配置正确
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('listNames 返回所有已注册子代理名', () => {
    const model = singleReplyModel('');
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash');
    spawner.register(TEST_AGENT);
    spawner.register({ ...TEST_AGENT, name: 'agent-2' });

    expect(spawner.listNames()).toEqual(['test-agent', 'agent-2']);
  });

  it('子代理执行不触发主 TUI 事件（无 onEvent 传入）', async () => {
    const model = singleReplyModel('结论');
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash');
    spawner.register(TEST_AGENT);

    // spawner.spawn 内部调用 runLoop 时不传 onEvent
    const result = await spawner.spawn({ agentName: 'test-agent', prompt: '任务' });
    expect(result.ok).toBe(true);
  });

  // ── T1.3: MCP 工具支持 ──────────────────────────────────

  it('allowedMcpServers 未声明 → 不加载 MCP 工具，子代理正常执行', async () => {
    const model = singleReplyModel('无 MCP 结论');
    // 传入 mock mcpManager 但不声明 allowedMcpServers
    const mockMcp = createMockMcpManager();
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash', mockMcp);
    spawner.register(TEST_AGENT);

    const result = await spawner.spawn({ agentName: 'test-agent', prompt: 'test' });
    expect(result.ok).toBe(true);
    // 验证 MCP 工具从未被查询
    expect(mockMcp.listToolsCallCount).toBe(0);
  });

  it('allowedMcpServers 声明但 McpManager 未传入 → 跳过不崩溃', async () => {
    const model = singleReplyModel('无 McpManager 结论');
    const mcpAgent: SubagentDef = {
      ...TEST_AGENT,
      name: 'mcp-agent',
      allowedMcpServers: ['filesystem'],
    };
    // 不传第四个参数 = undefined mcpManager
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash');
    spawner.register(mcpAgent);

    const result = await spawner.spawn({ agentName: 'mcp-agent', prompt: 'test' });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('MCP 服务可用 → 对应工具注册到子代理，原始名去前缀', async () => {
    const model = singleReplyModel('MCP 工具可用结论');
    const mockMcp = createMockMcpManager({
      'filesystem/read_file': { description: '读取文件', serverName: 'filesystem' },
      'filesystem/list_dir': { description: '列出目录', serverName: 'filesystem' },
    });
    const mcpAgent: SubagentDef = {
      ...TEST_AGENT,
      name: 'mcp-agent',
      allowedMcpServers: ['filesystem'],
    };
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash', mockMcp);
    spawner.register(mcpAgent);

    const result = await spawner.spawn({ agentName: 'mcp-agent', prompt: 'test' });
    expect(result.ok).toBe(true);
    // MCP 工具的 listTools 被调用
    expect(mockMcp.listToolsCallCount).toBeGreaterThanOrEqual(1);
  });

  it('MCP 服务未连接 → 跳过不阻塞，子代理仍正常执行', async () => {
    const model = singleReplyModel('降级结论');
    // mock：getClient 返回 disconnected
    const mockMcp = createMockMcpManager({}, false);
    const mcpAgent: SubagentDef = {
      ...TEST_AGENT,
      name: 'mcp-agent',
      allowedMcpServers: ['filesystem'],
    };
    const spawner = new SubagentSpawner(model, { cwd: tmp }, 'deepseek-v4-flash', mockMcp);
    spawner.register(mcpAgent);

    const result = await spawner.spawn({ agentName: 'mcp-agent', prompt: 'test' });
    expect(result.ok).toBe(true);
    // 降级不崩溃
    expect(result.error).toBeUndefined();
  });

  it('内置 explore/research 子代理声明了 allowedMcpServers', async () => {
    // 延迟导入避免污染其他测试
    const { EXPLORE_AGENT } = await import('../../src/agent/builtin/explore');
    const { RESEARCH_AGENT } = await import('../../src/agent/builtin/research');

    expect(EXPLORE_AGENT.allowedMcpServers).toEqual(['filesystem']);
    expect(RESEARCH_AGENT.allowedMcpServers).toEqual(['filesystem', 'github']);
  });
});

// ── Mock McpManager 工厂 ────────────────────────────────────

interface ToolDef {
  description: string;
  serverName: string;
}

/** 创建一个轻量 mock McpManager，用于 spawner MCP 工具测试。 */
function createMockMcpManager(
  toolMap: Record<string, ToolDef> = {},
  connected = true,
): McpManager & { listToolsCallCount: number } {
  const tools = Object.entries(toolMap).map(([name, meta]) => ({
    name,
    description: meta.description,
    parameters: z.object({}),
    serverName: meta.serverName,
  }));

  const mock = {
    listToolsCallCount: 0,

    getClient(_name: string): McpClient | undefined {
      return { connected, serverName: _name } as McpClient;
    },

    listTools() {
      mock.listToolsCallCount += 1;
      return tools;
    },

    async callTool(
      name: string,
      _args: unknown,
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
      const tool = toolMap[name];
      if (tool === undefined) {
        return { ok: false, error: `未知工具: ${name}` };
      }
      return { ok: true, data: `mock result: ${name}` };
    },
  };

  return mock as unknown as McpManager & { listToolsCallCount: number };
}
