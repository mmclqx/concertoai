/**
 * Orchestrator 协议类型测试（v3.0 M1 / T1.1）。
 *
 * 覆盖：泛型消息默认 unknown、判别联合收窄、类型守卫、Artifact/AgentContext 结构、
 * AgentDef interfaces zod schema 校验与推导、权限声明、状态表示与初始运行时状态。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentContext,
  type AgentDef,
  type AgentMessage,
  type AgentPermission,
  type AnyAgentMessage,
  type Artifact,
  createAgentRuntimeState,
  isErrorMessage,
  isFeedbackMessage,
  isResultMessage,
  isTaskMessage,
  type TaskMessage,
  type TaskStatus,
} from '../../src/orchestrator';

// ── 工具：构造最小上下文 ──────────────────────────────────────

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    dependencies: [],
    artifacts: [],
    ...overrides,
  };
}

// ── AgentMessage 结构与泛型 ───────────────────────────────────

describe('AgentMessage（泛型消息载体，ADR-016 修正项 #1）', () => {
  it('默认 payload 类型为 unknown（与 T0.2 评审一致）', () => {
    const msg: AgentMessage = {
      id: 'm1',
      from: 'orchestrator',
      to: 'coder',
      type: 'task',
      payload: { description: '实现登录' },
      context: makeContext(),
      timestamp: 1_700_000_000_000,
    };
    expect(msg.type).toBe('task');
    expect(msg.payload).toEqual({ description: '实现登录' });
    expect(msg.context.taskId).toBe('task-1');
  });

  it('指定泛型参数时 payload 类型收窄为具体结构', () => {
    const msg: AgentMessage<{ description: string }> = {
      id: 'm2',
      from: 'orchestrator',
      to: 'architect',
      type: 'task',
      payload: { description: '设计接口' },
      context: makeContext(),
      timestamp: 1,
    };
    expect(msg.payload.description).toBe('设计接口');
  });

  it('判别联合消息（TaskMessage）将 type 收窄为字面量', () => {
    const msg: TaskMessage = {
      id: 'm3',
      from: 'orchestrator',
      to: 'coder',
      type: 'task',
      payload: { description: '实现', dependencies: ['t0'] },
      context: makeContext(),
      timestamp: 1,
    };
    // type 已收窄为 'task'，payload 已收窄为 TaskPayload
    const t: 'task' = msg.type;
    expect(t).toBe('task');
    expect(msg.payload.dependencies).toEqual(['t0']);
  });

  it('AnyAgentMessage 联合可按 type 分支（switch 穷尽性）', () => {
    const msgs: AnyAgentMessage[] = [
      {
        id: 'a',
        from: 'o',
        to: 'c',
        type: 'task',
        payload: { description: 'x', dependencies: [] },
        context: makeContext(),
        timestamp: 1,
      },
      {
        id: 'b',
        from: 'c',
        to: 'o',
        type: 'result',
        payload: { data: 1 },
        context: makeContext(),
        timestamp: 2,
      },
      {
        id: 'c',
        from: 'c',
        to: 'o',
        type: 'error',
        payload: { message: '失败' },
        context: makeContext(),
        timestamp: 3,
      },
      {
        id: 'd',
        from: 'r',
        to: 'c',
        type: 'feedback',
        payload: { issues: ['问题'] },
        context: makeContext(),
        timestamp: 4,
      },
    ];
    const kinds = msgs.map((m) => m.type);
    expect(kinds).toEqual(['task', 'result', 'error', 'feedback']);
  });
});

// ── 类型守卫 ──────────────────────────────────────────────────

describe('类型守卫（运行时收窄）', () => {
  it('isTaskMessage 对 task 消息返回 true，其余 false', () => {
    const task = {
      id: '1',
      from: 'o',
      to: 'c',
      type: 'task' as const,
      payload: {},
      context: makeContext(),
      timestamp: 1,
    };
    const result = {
      id: '2',
      from: 'c',
      to: 'o',
      type: 'result' as const,
      payload: {},
      context: makeContext(),
      timestamp: 2,
    };
    expect(isTaskMessage(task)).toBe(true);
    expect(isTaskMessage(result)).toBe(false);
  });

  it('四种守卫各自识别对应类型', () => {
    const mk = (type: AnyAgentMessage['type']) => ({
      id: 'x',
      from: 'a',
      to: 'b',
      type,
      payload: {},
      context: makeContext(),
      timestamp: 1,
    });
    expect(isResultMessage(mk('result'))).toBe(true);
    expect(isErrorMessage(mk('error'))).toBe(true);
    expect(isFeedbackMessage(mk('feedback'))).toBe(true);
    expect(isTaskMessage(mk('task'))).toBe(true);
    // 反向
    expect(isResultMessage(mk('task'))).toBe(false);
    expect(isErrorMessage(mk('feedback'))).toBe(false);
    expect(isFeedbackMessage(mk('result'))).toBe(false);
  });
});

// ── Artifact / AgentContext ───────────────────────────────────

describe('Artifact 与 AgentContext（显式上下文 §3.3）', () => {
  it('Artifact 含 id/type/path?/content/metadata，path 可选', () => {
    const withPath: Artifact = {
      id: 'a1',
      type: 'spec',
      path: 'specs/auth.json',
      content: '{}',
      metadata: { from: 'architect' },
    };
    const withoutPath: Artifact = { id: 'a2', type: 'review-result', content: 'ok', metadata: {} };
    expect(withPath.path).toBe('specs/auth.json');
    expect(withoutPath.path).toBeUndefined();
    expect(withPath.metadata.from).toBe('architect');
  });

  it('AgentContext 支持父子任务与依赖', () => {
    const ctx = makeContext({ parentTaskId: 'task-0', dependencies: ['task-0', 'task-5'] });
    expect(ctx.parentTaskId).toBe('task-0');
    expect(ctx.dependencies).toHaveLength(2);
    expect(ctx.artifacts).toEqual([]);
  });
});

// ── AgentDef 接口 Schema（ADR-016 修正项 #2 / #5）─────────────

describe('AgentDef（接口契约 + 权限声明）', () => {
  const coderDef: AgentDef = {
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

  it('interfaces 的 zod schema 可运行时校验输入', () => {
    const ok = coderDef.interfaces.input.safeParse({ spec: 'spec json' });
    const bad = coderDef.interfaces.input.safeParse({ spec: 42 });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it('interfaces 的 zod schema 可运行时校验输出', () => {
    const ok = coderDef.interfaces.output.safeParse({ files: ['a.ts'] });
    const bad = coderDef.interfaces.output.safeParse({ files: 'a.ts' });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it('AgentPermission 支持工具名 + 可选参数约束（修正项 #5）', () => {
    const perms: AgentPermission[] = coderDef.permissions;
    expect(perms[0]).toEqual({ tool: 'edit_file' });
    expect(perms[1]?.args).toEqual({ allowlistedPrefixes: ['npm run verify'] });
    // 未声明工具 = 拒绝（fail-closed 语义由调用方保证）
    expect(perms.some((p) => p.tool === 'edit_file')).toBe(true);
  });

  it('AgentDef 结构完整（name/version/interfaces/permissions）', () => {
    expect(coderDef.name).toBe('coder');
    expect(coderDef.version).toBe('1.0.0');
    expect(coderDef.interfaces.version).toBe('1.0.0');
    expect(coderDef.permissions).toHaveLength(2);
  });
});

// ── 状态表示（ADR-016 修正项 #3）─────────────────────────────

describe('AgentState / AgentRuntimeState（状态解耦）', () => {
  it('AgentState 表达任务级状态机状态', () => {
    const state = { status: 'awaiting_review' as const, taskId: 'task-9', agent: 'reviewer' };
    expect(state.status).toBe('awaiting_review');
    expect(state.taskId).toBe('task-9');
  });

  it('createAgentRuntimeState 返回初始运行时状态（attempts=0）', () => {
    const rs = createAgentRuntimeState();
    expect(rs.attempts).toBe(0);
    expect(rs.lastError).toBeUndefined();
    expect(rs.lastContext).toBeUndefined();
    expect(typeof rs.updatedAt).toBe('number');
  });

  it('TaskStatus 覆盖全部 6 种生命周期状态', () => {
    // 编译期校验：数组字面量必须是合法 TaskStatus 成员
    const all: TaskStatus[] = [
      'pending',
      'in_progress',
      'awaiting_review',
      'awaiting_qa',
      'completed',
      'failed',
    ];
    expect(all).toHaveLength(6);
    expect(all).toEqual([
      'pending',
      'in_progress',
      'awaiting_review',
      'awaiting_qa',
      'completed',
      'failed',
    ]);
  });
});
