/**
 * Orchestrator Agent 测试（v3.0 M2 / T2.3）。
 *
 * 覆盖验收标准：
 * - 接收用户需求 → 模型拆解为结构化 Task[]（含依赖、负责人 Agent、验收标准）；
 * - 按调度器分配任务给对应 Agent（Fake 注册表验证分发与执行顺序）；
 * - 收集各 Agent 结果，聚合为最终输出（含中间工件引用）；
 * - 审批流：onPlan 确认执行 / 拒绝取消；
 * - 模型输出容错：JSON 围栏 / 非法 JSON / 结构不符分别处理；
 * - 失败场景：Agent 未注册、任务失败级联跳过。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Agent } from '../../src/agents';
import {
  artifactTypeForAgent,
  decomposeRequirement,
  InMemoryAgentRegistry,
  Orchestrator,
  type OrchestratorTask,
  parseOrchestratorTasks,
} from '../../src/agents';
import type { ChatCompletionChunk, ModelClient } from '../../src/model/client';
import type { AgentContext } from '../../src/orchestrator';
import { createAgentRuntimeState } from '../../src/orchestrator';

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

/** 构造一个最小 AgentContext（T2.3 显式上下文骨架）。 */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess-1',
    taskId: 'root',
    parentTaskId: 'task-0',
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

/** 构造一个可记录输入的 Fake Agent（输出固定 data，记录收到的 description）。 */
function makeFakeAgent(
  name: string,
  output?: unknown,
  onExecute?: (input: unknown) => void,
): Agent {
  return {
    def: {
      name,
      version: '1.0.0',
      interfaces: {
        input: z.object({ description: z.string() }),
        output: z.unknown(),
        version: '1.0.0',
      },
      permissions: [],
    },
    runtimeState: createAgentRuntimeState(),
    async execute(input) {
      onExecute?.(input);
      return output ?? { name, done: true };
    },
    async send() {},
    async receive() {
      return undefined;
    },
  };
}

/** 注册一个 Fake Agent 到注册表。 */
function registerFakeAgent(
  registry: InMemoryAgentRegistry,
  name: string,
  output?: unknown,
  onExecute?: (input: unknown) => void,
): void {
  const agent = makeFakeAgent(name, output, onExecute);
  registry.register(agent.def, agent);
}

// ── parseOrchestratorTasks：模型输出解析 ──────────────────────

describe('parseOrchestratorTasks（模型输出解析）', () => {
  it('解析合法 JSON 数组（含依赖/负责人/验收标准）', () => {
    const text = JSON.stringify([
      {
        id: 't1',
        description: '定义接口（验收：类型齐全）',
        agent: 'architect',
        dependencies: [],
        files: ['src/types.ts'],
      },
      {
        id: 't2',
        description: '实现编码（验收：测试通过）',
        agent: 'coder',
        dependencies: ['t1'],
      },
    ]);
    const tasks = parseOrchestratorTasks(text);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.agent).toBe('architect');
    expect(tasks[0]?.files).toEqual(['src/types.ts']);
    expect(tasks[1]?.dependencies).toEqual(['t1']);
  });

  it('容忍 ```json 围栏包裹', () => {
    const text =
      '```json\n' +
      JSON.stringify([{ id: 't1', description: 'x', agent: 'coder', dependencies: [] }]) +
      '\n```';
    const tasks = parseOrchestratorTasks(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('t1');
  });

  it('缺少 dependencies 时默认空数组（schema default）', () => {
    const text = JSON.stringify([{ id: 't1', description: 'x', agent: 'qa' }]);
    const tasks = parseOrchestratorTasks(text);
    expect(tasks[0]?.dependencies).toEqual([]);
  });

  it('非法 JSON 抛中文错误（含原文片段）', () => {
    expect(() => parseOrchestratorTasks('{not json')).toThrow(/需求拆解失败.*不是合法 JSON/s);
  });

  it('结构不符协议抛错（agent 缺失）', () => {
    const text = JSON.stringify([{ id: 't1', description: 'x' }]);
    expect(() => parseOrchestratorTasks(text)).toThrow(/结构不符合协议/);
  });
});

// ── decomposeRequirement：模型拆解 ────────────────────────────

describe('decomposeRequirement（需求拆解）', () => {
  it('流式收集模型输出并解析为任务清单', async () => {
    const tasksJson = JSON.stringify([
      { id: 't1', description: '设计', agent: 'architect', dependencies: [] },
      { id: 't2', description: '编码', agent: 'coder', dependencies: ['t1'] },
    ]);
    // 模拟流式：分两段返回
    const client = new FakeModelClient([tasksJson.slice(0, 30), tasksJson.slice(30)]);
    const tasks = await decomposeRequirement(client, 'fake-model', '做一个 TODO 应用');
    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.dependencies).toEqual(['t1']);
  });
});

// ── artifactTypeForAgent：角色 → 工件类型 ─────────────────────

describe('artifactTypeForAgent（角色映射工件类型）', () => {
  it('architect→spec / coder→code / reviewer→review-result / qa→test-report / 默认→file', () => {
    expect(artifactTypeForAgent('architect')).toBe('spec');
    expect(artifactTypeForAgent('coder')).toBe('code');
    expect(artifactTypeForAgent('reviewer')).toBe('review-result');
    expect(artifactTypeForAgent('qa')).toBe('test-report');
    expect(artifactTypeForAgent('custom')).toBe('file');
  });
});

// ── Orchestrator.run：全流程 ──────────────────────────────────

describe('Orchestrator.run（拆解 → 审批 → 调度 → 聚合）', () => {
  const planTasks: OrchestratorTask[] = [
    { id: 't1', description: '设计接口', agent: 'architect', dependencies: [] },
    { id: 't2', description: '实现编码', agent: 'coder', dependencies: ['t1'] },
    { id: 't3', description: '测试验证', agent: 'qa', dependencies: ['t2'] },
  ];

  function makeClient(): FakeModelClient {
    return new FakeModelClient([JSON.stringify(planTasks)]);
  }

  function makeRegistry(): InMemoryAgentRegistry {
    const registry = new InMemoryAgentRegistry();
    registerFakeAgent(registry, 'architect', { spec: 'v1' });
    registerFakeAgent(registry, 'coder', { code: 'impl' });
    registerFakeAgent(registry, 'qa', { report: 'all green' });
    return registry;
  }

  it('完整链路：拆解 → 调度分配 → 聚合输出（含工件引用）', async () => {
    const calls: string[] = [];
    const registry = new InMemoryAgentRegistry();
    registerFakeAgent(registry, 'architect', { spec: 'v1' }, (input) => {
      calls.push('architect');
      expect((input as { description: string }).description).toBe('设计接口');
    });
    registerFakeAgent(registry, 'coder', { code: 'impl' }, () => calls.push('coder'));
    registerFakeAgent(registry, 'qa', { report: 'ok' }, () => calls.push('qa'));

    const orch = new Orchestrator({ client: makeClient(), model: 'fake', registry });
    const result = await orch.run('实现一个 TODO 应用', makeContext());

    expect(result.ok).toBe(true);
    expect(result.order).toEqual(['t1', 't2', 't3']);
    // 依赖顺序：architect → coder → qa（串行）
    expect(calls).toEqual(['architect', 'coder', 'qa']);
    expect(result.executions).toHaveLength(3);
    expect(result.failed).toEqual({});
    expect(result.skipped).toEqual([]);
    // 聚合工件：每个成功任务一个 artifact，类型按角色映射
    expect(result.artifacts.map((a) => a.type)).toEqual(['spec', 'code', 'test-report']);
    expect(result.artifacts[0]?.metadata.fromAgent).toBe('architect');
    expect(result.summary).toContain('全部 3 个任务完成');
  });

  it('审批流：onPlan 确认后执行', async () => {
    let planSeen: OrchestratorTask[] | undefined;
    const registry = makeRegistry();
    const orch = new Orchestrator({
      client: makeClient(),
      model: 'fake',
      registry,
      onPlan: async (tasks) => {
        planSeen = tasks;
        return true;
      },
    });
    const result = await orch.run('需求', makeContext());
    expect(planSeen).toHaveLength(3);
    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(3);
  });

  it('审批流：onPlan 拒绝 → 取消执行且无副作用', async () => {
    const registry = makeRegistry();
    const orch = new Orchestrator({
      client: makeClient(),
      model: 'fake',
      registry,
      onPlan: async () => false,
    });
    const result = await orch.run('需求', makeContext());
    expect(result.ok).toBe(false);
    expect(result.executions).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.summary).toContain('取消执行');
  });

  it('任务失败 → failed 记录错误，下游级联跳过', async () => {
    const registry = new InMemoryAgentRegistry();
    registerFakeAgent(registry, 'architect', { spec: 'v1' });
    registerFakeAgent(registry, 'coder', undefined, () => {
      throw new Error('编译失败');
    });
    registerFakeAgent(registry, 'qa', { report: 'ok' });

    const orch = new Orchestrator({
      client: makeClient(),
      model: 'fake',
      registry,
      concurrency: 1,
    });
    const result = await orch.run('需求', makeContext());
    expect(result.ok).toBe(false);
    expect(result.failed.t2).toBe('编译失败');
    expect(result.skipped).toContain('t3');
    expect(result.summary).toContain('失败 1 个');
  });

  it('Agent 未注册 → 该任务失败并给出明确错误', async () => {
    const registry = new InMemoryAgentRegistry();
    registerFakeAgent(registry, 'architect', { spec: 'v1' });
    // t2 负责人 'coder' 未注册
    const orch = new Orchestrator({ client: makeClient(), model: 'fake', registry });
    const result = await orch.run('需求', makeContext());
    expect(result.ok).toBe(false);
    expect(result.failed.t2).toContain('未注册');
    expect(result.skipped).toContain('t3');
  });

  it('空任务清单（模型未拆解出任务）→ ok 为 false', async () => {
    const registry = makeRegistry();
    const client = new FakeModelClient([JSON.stringify([])]);
    const orch = new Orchestrator({ client, model: 'fake', registry });
    const result = await orch.run('简单需求', makeContext());
    expect(result.ok).toBe(false);
    expect(result.executions).toEqual([]);
  });
});
