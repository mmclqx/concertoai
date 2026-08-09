/**
 * 显式上下文管理器测试（v3.0 M1 / T1.3，§3.3）。
 *
 * 覆盖：serialize/deserialize 往返一致、按 taskId 子集提取、合并去重、
 * 64KB 大小上限（抛错 + 截断标记）、来源追踪（fromAgent/messageId/taskId）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext, Artifact } from '../../src/orchestrator';
import {
  ARTIFACT_META_FROM_AGENT,
  ARTIFACT_META_MESSAGE_ID,
  ARTIFACT_META_TASK_ID,
  ContextLimitError,
  createArtifact,
  deserialize,
  enforceLimit,
  extractSubset,
  mergeContexts,
  serialize,
} from '../../src/orchestrator';

// ── 测试用上下文构造 ──────────────────────────────────────────

/** 构造一个含多任务 artifacts 的上下文（模拟大上下文）。 */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const artifacts: Artifact[] = [
    createArtifact({
      id: 'a1',
      type: 'spec',
      content: 'spec-1',
      fromAgent: 'architect',
      messageId: 'm1',
      taskId: 'task-1',
    }),
    createArtifact({
      id: 'a2',
      type: 'code',
      content: 'code-1',
      fromAgent: 'coder',
      messageId: 'm2',
      taskId: 'task-1',
    }),
    createArtifact({
      id: 'a3',
      type: 'code',
      content: 'code-2',
      fromAgent: 'coder',
      messageId: 'm3',
      taskId: 'task-2',
    }),
    createArtifact({
      id: 'a4',
      type: 'review-result',
      content: 'ok',
      fromAgent: 'reviewer',
      messageId: 'm4',
      taskId: 'task-2',
    }),
  ];
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    parentTaskId: 'task-0',
    dependencies: ['task-0'],
    artifacts,
    ...overrides,
  };
}

// ── serialize / deserialize ───────────────────────────────────

describe('serialize / deserialize（往返一致）', () => {
  it('序列化后可反序列化，结构与来源追踪完整还原', () => {
    const ctx = makeContext();
    const json = serialize(ctx);
    const back = deserialize(json);
    expect(back).toEqual(ctx);
    expect(back.artifacts[0]?.metadata[ARTIFACT_META_FROM_AGENT]).toBe('architect');
    expect(back.artifacts[0]?.metadata[ARTIFACT_META_MESSAGE_ID]).toBe('m1');
    expect(back.artifacts[0]?.metadata[ARTIFACT_META_TASK_ID]).toBe('task-1');
  });

  it('deserialize 对非法 JSON 抛错', () => {
    expect(() => deserialize('{not json')).toThrow(/反序列化失败/);
  });

  it('deserialize 对结构不完整 JSON 抛错', () => {
    expect(() => deserialize('{"sessionId":"s"}')).toThrow(/不是有效的 AgentContext/);
  });

  it('序列化会保留 UTF-8 中文内容', () => {
    const ctx = makeContext({
      artifacts: [
        createArtifact({
          id: 'a-cn',
          type: 'spec',
          content: '中文规范',
          fromAgent: 'architect',
          messageId: 'm-cn',
          taskId: 'task-1',
        }),
      ],
    });
    const back = deserialize(serialize(ctx));
    expect(back.artifacts[0]?.content).toBe('中文规范');
  });
});

// ── extractSubset ─────────────────────────────────────────────

describe('extractSubset（按 taskId 提取子集）', () => {
  it('仅保留归属指定任务的 artifacts（避免全量复制）', () => {
    const ctx = makeContext();
    const subset = extractSubset(ctx, 'task-2');
    expect(subset.taskId).toBe('task-2');
    expect(subset.artifacts.map((a) => a.id)).toEqual(['a3', 'a4']);
  });

  it('保留上下文骨架（sessionId/dependencies/parentTaskId）', () => {
    const ctx = makeContext();
    const subset = extractSubset(ctx, 'task-2');
    expect(subset.sessionId).toBe('sess-1');
    expect(subset.parentTaskId).toBe('task-0');
    expect(subset.dependencies).toEqual(['task-0']);
  });

  it('无匹配任务时返回空 artifacts', () => {
    const ctx = makeContext();
    const subset = extractSubset(ctx, 'task-999');
    expect(subset.artifacts).toEqual([]);
  });
});

// ── mergeContexts ─────────────────────────────────────────────

describe('mergeContexts（合并去重）', () => {
  it('合并多个上下文的 artifacts，按 artifactId 去重', () => {
    const ctx1 = makeContext();
    const ctx2 = makeContext({
      taskId: 'task-2',
      artifacts: [
        createArtifact({
          id: 'a5',
          type: 'file',
          content: 'x',
          fromAgent: 'qa',
          messageId: 'm5',
          taskId: 'task-2',
        }),
      ],
    });
    const merged = mergeContexts(ctx1, ctx2);
    // a1~a4 来自 ctx1，a5 来自 ctx2；无重复 id
    expect(merged.artifacts.map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('重复 artifactId 只保留第一个', () => {
    const dup1 = makeContext();
    const dup2 = makeContext(); // 相同 artifact id a1~a4
    const merged = mergeContexts(dup1, dup2);
    expect(merged.artifacts).toHaveLength(4);
  });

  it('dependencies 合并去重', () => {
    const ctx1 = makeContext({ dependencies: ['task-0', 'task-5'] });
    const ctx2 = makeContext({ taskId: 'task-2', dependencies: ['task-5', 'task-9'] });
    const merged = mergeContexts(ctx1, ctx2);
    expect(merged.dependencies).toEqual(['task-0', 'task-5', 'task-9']);
  });

  it('骨架取自第一个上下文', () => {
    const ctx1 = makeContext();
    const ctx2 = makeContext({ sessionId: 'sess-2', taskId: 'task-2' });
    const merged = mergeContexts(ctx1, ctx2);
    expect(merged.sessionId).toBe('sess-1');
    expect(merged.taskId).toBe('task-1');
  });

  it('空参调用抛错', () => {
    expect(() => mergeContexts()).toThrow(/至少一个上下文/);
  });
});

// ── 大小上限保护 ──────────────────────────────────────────────

describe('大小上限保护（默认 64KB）', () => {
  it('未超限时 serialize 正常返回', () => {
    const ctx = makeContext();
    expect(() => serialize(ctx)).not.toThrow();
  });

  it('超限时 serialize 抛 ContextLimitError（携带字节数）', () => {
    const big = 'x'.repeat(70 * 1024); // 70KB
    const ctx = makeContext({
      artifacts: [
        createArtifact({
          id: 'big',
          type: 'file',
          content: big,
          fromAgent: 'coder',
          messageId: 'm-big',
          taskId: 'task-1',
        }),
      ],
    });
    try {
      serialize(ctx);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(ContextLimitError);
      if (err instanceof ContextLimitError) {
        expect(err.totalBytes).toBeGreaterThan(64 * 1024);
        expect(err.limitBytes).toBe(64 * 1024);
      }
    }
  });

  it('可自定义更小的上限', () => {
    const ctx = makeContext();
    expect(() => serialize(ctx, 10)).toThrow(ContextLimitError);
  });

  it('enforceLimit 超限时截断并标记 truncated', () => {
    const big = 'y'.repeat(40 * 1024); // 每个 40KB，两个即 80KB
    const ctx = makeContext({
      artifacts: [
        createArtifact({
          id: 'big1',
          type: 'file',
          content: big,
          fromAgent: 'coder',
          messageId: 'm1',
          taskId: 'task-1',
        }),
        createArtifact({
          id: 'big2',
          type: 'file',
          content: big,
          fromAgent: 'coder',
          messageId: 'm2',
          taskId: 'task-1',
        }),
      ],
    });
    const { context, truncated } = enforceLimit(ctx, 50 * 1024);
    expect(truncated).toBe(true);
    // 骨架 + 第一个 40KB artifact 可容纳（~40KB+），第二个被丢弃
    expect(context.artifacts.map((a) => a.id)).toEqual(['big1']);
  });

  it('enforceLimit 未超限时 truncated 为 false 且上下文不变', () => {
    const ctx = makeContext();
    const { context, truncated } = enforceLimit(ctx);
    expect(truncated).toBe(false);
    expect(context).toEqual(ctx);
  });
});

// ── 来源追踪 ──────────────────────────────────────────────────

describe('来源追踪（createArtifact metadata）', () => {
  it('createArtifact 记录 fromAgent/messageId/taskId', () => {
    const artifact = createArtifact({
      id: 'x',
      type: 'spec',
      content: '{}',
      fromAgent: 'architect',
      messageId: 'm-1',
      taskId: 't-1',
    });
    expect(artifact.metadata[ARTIFACT_META_FROM_AGENT]).toBe('architect');
    expect(artifact.metadata[ARTIFACT_META_MESSAGE_ID]).toBe('m-1');
    expect(artifact.metadata[ARTIFACT_META_TASK_ID]).toBe('t-1');
  });

  it('来源追踪在序列化往返后保留（可追溯）', () => {
    const ctx = makeContext();
    const back = deserialize(serialize(ctx));
    const artifact = back.artifacts.find((a) => a.id === 'a2');
    expect(artifact?.metadata[ARTIFACT_META_FROM_AGENT]).toBe('coder');
    expect(artifact?.metadata[ARTIFACT_META_MESSAGE_ID]).toBe('m2');
  });
});
