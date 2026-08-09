/**
 * 多 Agent 协作 E2E（v3.0 M6 / T6.1）。
 *
 * 端到端串联验证（跨模块，非单模块单元测试）：
 * - E2E-1：FakeModel → Orchestrator 拆解 5 子任务（含并行组）→ 拓扑调度正确 + 并行执行；
 * - E2E-4：Agent 市场 install + promote → /agent list（formatAgentList）识别全链路。
 *
 * 依赖：M1-M5 全部能力（types/context/scheduler/orchestrator/market/agents）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type Agent,
  InMemoryAgentRegistry,
  Orchestrator,
  type OrchestratorTask,
} from '../../src/agents';
import { formatAgentList } from '../../src/cli/slash/agent';
import {
  AgentInstaller,
  type MarketRegistry,
  parseMarketRegistry,
  promoteSkill,
} from '../../src/market';
import type { ChatCompletionChunk, ModelClient } from '../../src/model/client';
import type { AgentContext } from '../../src/orchestrator';
import { createAgentRuntimeState } from '../../src/orchestrator';
import type { SkillLoader } from '../../src/skill/loader';

// ── Fake 模型客户端（流式返回预设文本）───────────────────────

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

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess-e2e',
    taskId: 'root-e2e',
    parentTaskId: undefined,
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

/** 构造带并发计数（start/end）的 Fake Agent，验证并行组真正并发。 */
function makeConcurrentAgent(name: string, counter: { peak: number; current: number }): Agent {
  return {
    def: {
      name,
      version: '1.0.0',
      interfaces: {
        input: z.any(),
        output: z.any(),
        version: '1.0.0',
      },
      permissions: [],
    },
    runtimeState: createAgentRuntimeState(),
    async execute() {
      counter.current += 1;
      counter.peak = Math.max(counter.peak, counter.current);
      await new Promise((r) => setTimeout(r, 15));
      counter.current -= 1;
      return { name, done: true };
    },
    async send() {},
    async receive() {
      return undefined;
    },
  };
}

// ── E2E-1：拆解 5 子任务（含并行组）→ 拓扑调度 + 并行执行 ────

describe('E2E：Orchestrator 拆解 + 拓扑调度（含并行组）', () => {
  it('FakeModel 拆解 5 子任务 → 拓扑序正确 + 并行组并发执行 + 聚合 5 工件', async () => {
    const tasks: OrchestratorTask[] = [
      { id: 't1', description: '设计接口', agent: 'architect', dependencies: [] },
      { id: 't2', description: '实现认证', agent: 'coder', dependencies: ['t1'] },
      { id: 't3', description: '实现业务', agent: 'coder', dependencies: ['t1'] },
      { id: 't4', description: '测试验证', agent: 'qa', dependencies: ['t2', 't3'] },
      { id: 't5', description: '代码审查', agent: 'reviewer', dependencies: ['t4'] },
    ];
    const client = new FakeModelClient([JSON.stringify(tasks)]);
    const counter = { peak: 0, current: 0 };
    const reg = new InMemoryAgentRegistry();
    for (const name of ['architect', 'coder', 'reviewer', 'qa']) {
      const agent = makeConcurrentAgent(name, counter);
      reg.register(agent.def, agent);
    }

    const orch = new Orchestrator({ client, model: 'fake', registry: reg, concurrency: 3 });
    const result = await orch.run('实现 TODO 应用', makeContext());

    // 拓扑序：t1 最先、t5 最后、t4 在 t2/t3 之后
    expect(result.ok).toBe(true);
    expect(result.order[0]).toBe('t1');
    expect(result.order[4]).toBe('t5');
    expect(result.order.indexOf('t2')).toBeGreaterThan(result.order.indexOf('t1'));
    expect(result.order.indexOf('t3')).toBeGreaterThan(result.order.indexOf('t1'));
    expect(result.order.indexOf('t4')).toBeGreaterThan(
      Math.max(result.order.indexOf('t2'), result.order.indexOf('t3')),
    );
    // 并行组（t2/t3 无相互依赖）真正并发：并发峰值 ≥ 2
    expect(counter.peak).toBeGreaterThanOrEqual(2);
    // 聚合：5 任务 → 5 工件
    expect(result.executions).toHaveLength(5);
    expect(result.artifacts).toHaveLength(5);
    expect(result.failed).toEqual({});
  });
});

// ── E2E-4：市场安装 + promote → /agent list 识别全链路 ────────

describe('E2E：Agent 市场 install + promote → /agent list 识别', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lumen-e2e-market-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 构造合法外部 Agent 包。 */
  function makePackage(name: string): string {
    return JSON.stringify({
      def: {
        name,
        version: '1.0.0',
        interfaces: { input: { shape: 'object' }, output: { shape: 'object' }, version: '1.0.0' },
        permissions: [{ tool: 'read_file' }],
      },
      entry: 'module.exports = { execute: async () => ({ ok: true }) };',
    });
  }

  /** 构造含单个 external Agent 条目的注册表（经 parseMarketRegistry 校验，类型安全）。 */
  function makeRegistry(name: string): MarketRegistry {
    return parseMarketRegistry(
      JSON.stringify({
        registry: 'https://example.com/registry.json',
        skills: [],
        agents: [
          {
            type: 'agent',
            name,
            version: '1.0.0',
            description: '测试 Agent',
            author: 'tester',
            url: 'https://example.com/agents/agent.json',
            sha256: 'abc123',
            interfaces: {
              input: { shape: 'object' },
              output: { shape: 'object' },
              version: '1.0.0',
            },
            permissions: [{ tool: 'read_file' }],
            runtime: 'external',
          },
        ],
      }),
    );
  }

  it('install 外部 Agent + promote 技能 → formatAgentList 同时识别（内置 + 已安装 + 升级）', async () => {
    // 1. 安装外部 Agent（真实安装器，注入下载）
    const installer = new AgentInstaller({
      installDir: path.join(tmp, 'agents'),
      fetchRegistry: async () => makeRegistry('ext-agent'),
      fetchPackage: async () => makePackage('ext-agent'),
    });
    const installed = await installer.install('ext-agent');
    expect(installed.ok).toBe(true);

    // 2. promote 技能为 Agent（stub loader + tmp agentsDir）
    const stubLoader = {
      loadAll: () => {},
      get: () => ({
        name: 'code-review',
        description: '审查',
        version: '1.0.0',
        tools: ['read_file', 'search_content', 'list_directory'],
        body: '## 审查\n输出 ReviewResult。',
        sourcePath: '/tmp/skills/code-review/SKILL.md',
      }),
    } as unknown as SkillLoader;
    const promoted = promoteSkill({
      skillName: 'code-review',
      loader: stubLoader,
      installDir: path.join(tmp, 'agents'),
    });
    expect(promoted.ok).toBe(true);

    // 3. /agent list 识别全链路：内置 4 + 已安装 2（ext-agent + code-review）
    const deps = { installer, registry: new InMemoryAgentRegistry() };
    const content = formatAgentList(deps);
    expect(content).toContain('内置 4 个');
    expect(content).toContain('已安装外部 Agent（2 个）');
    expect(content).toContain('ext-agent');
    expect(content).toContain('code-review');
  });
});
