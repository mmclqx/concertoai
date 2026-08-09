/**
 * Agent 注册表与标准 Agent 接口测试（v3.0 M1 / T1.2）。
 *
 * 覆盖：AgentRegistry 注册/查询/卸载、权限声明读取、标准 Agent 契约
 * （输入输出符合 AgentDef.interfaces Schema、运行时状态、send/receive 消息收发）、
 * 与 T1.1 类型一致性（直接复用 orchestrator 类型，不重复定义）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Agent, AgentReply } from '../../src/agents';
import { InMemoryAgentRegistry } from '../../src/agents';
import type {
  AgentContext,
  AgentDef,
  AgentMessage,
  AnyAgentMessage,
  Artifact,
  TaskStatus,
} from '../../src/orchestrator';
import { createAgentRuntimeState } from '../../src/orchestrator';

// ── 测试用 Agent 定义 ─────────────────────────────────────────

/** 构造一个 Coder 风格的 AgentDef（接口 Schema + 权限声明）。 */
function makeCoderDef(): AgentDef {
  return {
    name: 'coder',
    version: '1.0.0',
    interfaces: {
      input: z.object({ spec: z.string() }),
      output: z.object({ files: z.array(z.string()) }),
      version: '1.0.0',
    },
    permissions: [
      { tool: 'edit_file' },
      { tool: 'run_command', args: { allowlistedPrefixes: ['npm run verify'] } },
    ],
  };
}

// ── 测试用最小上下文 ──────────────────────────────────────────

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const artifact: Artifact = {
    id: 'art-1',
    type: 'spec',
    content: '{}',
    metadata: { from: 'architect' },
  };
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    dependencies: [],
    artifacts: [artifact],
    ...overrides,
  };
}

// ── 测试用 Agent 实现（满足标准契约）──────────────────────────

class MockCoderAgent implements Agent {
  readonly def: AgentDef;
  runtimeState = createAgentRuntimeState();
  /** 记录收到的消息（验证 send/receive 链路）。 */
  received: AnyAgentMessage[] = [];
  /** 记录发送的消息（验证 send 调用）。 */
  sent: AgentMessage[] = [];

  constructor(def: AgentDef) {
    this.def = def;
  }

  async execute(input: unknown, _context: AgentContext): Promise<unknown> {
    // 输入必须符合 def.interfaces.input 声明的 Schema
    const parsed = this.def.interfaces.input.safeParse(input);
    if (!parsed.success) {
      throw new Error(`输入不符合接口 Schema: ${parsed.error.message}`);
    }
    const spec = (parsed.data as { spec: string }).spec;
    const output = { files: [`src/${spec}.ts`] };
    // 输出必须符合 def.interfaces.output 声明的 Schema
    const checked = this.def.interfaces.output.safeParse(output);
    if (!checked.success) {
      throw new Error(`输出不符合接口 Schema: ${checked.error.message}`);
    }
    return output;
  }

  async send(message: AgentMessage): Promise<void> {
    this.sent.push(message);
  }

  async receive(message: AnyAgentMessage): Promise<AgentReply | undefined> {
    this.received.push(message);
    if (message.type === 'task') {
      return { message: { ...message, id: 'reply-1', type: 'result', payload: { data: 'done' } } };
    }
    return undefined;
  }
}

// ── AgentRegistry 接口 ─────────────────────────────────────────

describe('AgentRegistry（注册/查询/卸载）', () => {
  it('register 后 has/get/list 可见', () => {
    const registry = new InMemoryAgentRegistry();
    const def = makeCoderDef();
    registry.register(def);
    expect(registry.has('coder')).toBe(true);
    expect(registry.get('coder')?.def.name).toBe('coder');
    expect(registry.list().map((e) => e.def.name)).toEqual(['coder']);
  });

  it('register 可关联实现实例', () => {
    const registry = new InMemoryAgentRegistry();
    const agent = new MockCoderAgent(makeCoderDef());
    registry.register(agent.def, agent);
    expect(registry.get('coder')?.impl).toBe(agent);
  });

  it('同名重复 register 抛错', () => {
    const registry = new InMemoryAgentRegistry();
    registry.register(makeCoderDef());
    expect(() => registry.register(makeCoderDef())).toThrow(/已存在/);
  });

  it('unregister 移除条目，不存在时返回 false', () => {
    const registry = new InMemoryAgentRegistry();
    registry.register(makeCoderDef());
    expect(registry.unregister('coder')).toBe(true);
    expect(registry.has('coder')).toBe(false);
    expect(registry.unregister('coder')).toBe(false);
  });

  it('list 按名称字典序排序', () => {
    const registry = new InMemoryAgentRegistry();
    registry.register(makeCoderDef());
    registry.register({ ...makeCoderDef(), name: 'architect' });
    registry.register({ ...makeCoderDef(), name: 'qa' });
    expect(registry.list().map((e) => e.def.name)).toEqual(['architect', 'coder', 'qa']);
  });

  it('get 不存在的名称返回 undefined', () => {
    const registry = new InMemoryAgentRegistry();
    expect(registry.get('ghost')).toBeUndefined();
    expect(registry.permissionsOf('ghost')).toBeUndefined();
  });
});

// ── 权限声明读取 ───────────────────────────────────────────────

describe('AgentRegistry.permissionsOf（供调度器与审批流）', () => {
  it('返回 AgentDef.permissions 权限声明', () => {
    const registry = new InMemoryAgentRegistry();
    registry.register(makeCoderDef());
    const perms = registry.permissionsOf('coder');
    expect(perms).toHaveLength(2);
    expect(perms?.[0]?.tool).toBe('edit_file');
    expect(perms?.[1]?.tool).toBe('run_command');
  });

  it('未声明权限的 Agent 返回空数组（fail-closed 语义由审批流保证）', () => {
    const registry = new InMemoryAgentRegistry();
    registry.register({ ...makeCoderDef(), permissions: [] });
    expect(registry.permissionsOf('coder')).toEqual([]);
  });
});

// ── 标准 Agent 契约 ───────────────────────────────────────────

describe('标准 Agent 接口（Agent 契约）', () => {
  it('execute 输入经 interfaces.input Schema 校验', async () => {
    const agent = new MockCoderAgent(makeCoderDef());
    const ctx = makeContext();
    await expect(agent.execute({ spec: 'auth' }, ctx)).resolves.toEqual({ files: ['src/auth.ts'] });
    // 非法输入（spec 不是 string）→ 抛错
    await expect(agent.execute({ spec: 42 }, ctx)).rejects.toThrow(/输入不符合接口 Schema/);
  });

  it('execute 输出经 interfaces.output Schema 校验（合法输出通过）', async () => {
    const agent = new MockCoderAgent(makeCoderDef());
    const ctx = makeContext();
    const result = await agent.execute({ spec: 'login' }, ctx);
    // 输出结构 { files: string[] } 合法
    expect(result).toEqual({ files: ['src/login.ts'] });
  });

  it('Agent 支持运行时状态（AgentRuntimeState）', () => {
    const agent = new MockCoderAgent(makeCoderDef());
    expect(agent.runtimeState.attempts).toBe(0);
    expect(typeof agent.runtimeState.updatedAt).toBe('number');
  });

  it('send 发送结构化消息（显式上下文随消息传递）', async () => {
    const agent = new MockCoderAgent(makeCoderDef());
    const ctx = makeContext();
    const msg: AgentMessage = {
      id: 'm1',
      from: 'orchestrator',
      to: 'coder',
      type: 'task',
      payload: { description: '实现登录', dependencies: [] },
      context: ctx,
      timestamp: 1,
    };
    await agent.send(msg);
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.context.taskId).toBe('task-1');
  });

  it('receive 处理消息并返回可选回复（task → result）', async () => {
    const agent = new MockCoderAgent(makeCoderDef());
    const ctx = makeContext();
    const taskMsg: AnyAgentMessage = {
      id: 'm2',
      from: 'orchestrator',
      to: 'coder',
      type: 'task',
      payload: { description: '实现登录', dependencies: [] },
      context: ctx,
      timestamp: 2,
    };
    const reply = await agent.receive(taskMsg);
    expect(agent.received).toHaveLength(1);
    expect(reply?.message?.type).toBe('result');
  });

  it('receive 对非 task 消息可返回 undefined（无回复）', async () => {
    const agent = new MockCoderAgent(makeCoderDef());
    const ctx = makeContext();
    const errMsg: AnyAgentMessage = {
      id: 'm3',
      from: 'qa',
      to: 'coder',
      type: 'error',
      payload: { message: '测试失败' },
      context: ctx,
      timestamp: 3,
    };
    const reply = await agent.receive(errMsg);
    expect(reply).toBeUndefined();
  });
});

// ── 与 T1.1 类型一致性 ────────────────────────────────────────

describe('与 T1.1 类型一致性（不重复定义）', () => {
  it('AgentDef / AgentContext / AgentMessage 均复用 orchestrator 类型', () => {
    // 编译期保证：这些类型来自 src/orchestrator，而非本地重定义
    const def = makeCoderDef();
    const statuses: TaskStatus[] = [
      'pending',
      'in_progress',
      'awaiting_review',
      'awaiting_qa',
      'completed',
      'failed',
    ];
    expect(def.interfaces.input).toBeDefined();
    expect(statuses).toHaveLength(6);
  });

  it('AgentInput/AgentOutput 从 AgentDef.interfaces 推导', () => {
    // 类型层面：Agent<typeof coderDef> 的 execute 输入/输出由 interfaces 推导
    // 运行时：schema 可校验输入/输出
    const def = makeCoderDef();
    const inputOk = def.interfaces.input.safeParse({ spec: 'x' });
    const outputOk = def.interfaces.output.safeParse({ files: ['a.ts'] });
    expect(inputOk.success).toBe(true);
    expect(outputOk.success).toBe(true);
  });
});
