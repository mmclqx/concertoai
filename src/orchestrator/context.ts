/**
 * 显式上下文管理器（v3.0 M1 / T1.3，§3.3）。
 *
 * 提供 AgentContext 的完整操作能力，保证「上下文是事实，而非记忆」：
 * - serialize / deserialize：JSON 往返一致（含大小上限保护，默认 64KB）；
 * - extractSubset：按 taskId 提取相关子集（按需传递，避免全量复制）；
 * - mergeContexts：合并多个上下文，按 artifactId 去重；
 * - 来源追踪：每条 artifact 通过 metadata 记录产生它的 Agent、消息 id 与任务 id。
 */

import type { AgentContext, Artifact, ArtifactType } from './types';

/** 默认上下文大小上限（64KB，字节）。 */
export const DEFAULT_CONTEXT_LIMIT_BYTES = 64 * 1024;

/** 来源追踪标准 metadata 键：产生该 artifact 的 Agent 名。 */
export const ARTIFACT_META_FROM_AGENT = 'fromAgent';
/** 来源追踪标准 metadata 键：产生该 artifact 的消息 id。 */
export const ARTIFACT_META_MESSAGE_ID = 'messageId';
/** 来源追踪标准 metadata 键：该 artifact 归属的任务 id。 */
export const ARTIFACT_META_TASK_ID = 'taskId';

/** 上下文超出大小上限时抛出的错误（携带字节数供调用方展示）。 */
export class ContextLimitError extends Error {
  /** 实际序列化字节数。 */
  readonly totalBytes: number;
  /** 上限字节数。 */
  readonly limitBytes: number;

  constructor(totalBytes: number, limitBytes: number) {
    super(`上下文超出大小上限: ${totalBytes} > ${limitBytes} 字节`);
    this.name = 'ContextLimitError';
    this.totalBytes = totalBytes;
    this.limitBytes = limitBytes;
  }
}

/** UTF-8 字节数编码器（Node 与浏览器通用，避免 Buffer 依赖）。 */
const encoder = new TextEncoder();

/** 计算字符串的 UTF-8 字节数（中文等多字节字符按实际编码长度计）。 */
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** 轻量结构校验：值是否为合法 AgentContext 骨架。 */
function isAgentContext(value: unknown): value is AgentContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    typeof v.taskId === 'string' &&
    Array.isArray(v.dependencies) &&
    Array.isArray(v.artifacts)
  );
}

/**
 * 创建带来源追踪的 Artifact（修正项 #4：metadata 记录 fromAgent/messageId/taskId）。
 * 调用方应保证 id 全局唯一（可观测性/审计日志引用）。
 */
export function createArtifact(input: {
  /** 工件 ID（全局唯一）。 */
  id: string;
  /** 工件类型。 */
  type: ArtifactType;
  /** 工件内容（文本）。 */
  content: string;
  /** 关联文件路径（可选）。 */
  path?: string;
  /** 产生该工件的 Agent 名。 */
  fromAgent: string;
  /** 产生该工件的消息 id。 */
  messageId: string;
  /** 该工件归属的任务 id。 */
  taskId: string;
}): Artifact {
  return {
    id: input.id,
    type: input.type,
    path: input.path,
    content: input.content,
    metadata: {
      [ARTIFACT_META_FROM_AGENT]: input.fromAgent,
      [ARTIFACT_META_MESSAGE_ID]: input.messageId,
      [ARTIFACT_META_TASK_ID]: input.taskId,
    },
  };
}

/**
 * 序列化上下文为 JSON 字符串。
 *
 * @param context    要序列化的上下文。
 * @param limitBytes 大小上限（默认 64KB）；超限抛 ContextLimitError。
 */
export function serialize(
  context: AgentContext,
  limitBytes: number = DEFAULT_CONTEXT_LIMIT_BYTES,
): string {
  const json = JSON.stringify(context);
  const totalBytes = utf8Bytes(json);
  if (totalBytes > limitBytes) {
    throw new ContextLimitError(totalBytes, limitBytes);
  }
  return json;
}

/**
 * 反序列化 JSON 字符串为 AgentContext（与 serialize 往返一致）。
 * 结构不合法时抛错，避免脏数据流入调度/闭环。
 */
export function deserialize(json: string): AgentContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    throw new Error(`反序列化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isAgentContext(parsed)) {
    throw new Error(
      '反序列化失败: JSON 不是有效的 AgentContext（缺 sessionId/taskId/dependencies/artifacts）',
    );
  }
  return parsed;
}

/**
 * 按 taskId 提取相关子集（§3.3 按需传递，避免全量复制）。
 *
 * 保留上下文骨架（sessionId/taskId/dependencies），仅保留归属该任务的
 * artifacts（按 metadata.taskId 匹配），用于把大上下文裁剪为单个任务视角。
 */
export function extractSubset(context: AgentContext, taskId: string): AgentContext {
  return {
    ...context,
    taskId,
    artifacts: context.artifacts.filter((a) => a.metadata[ARTIFACT_META_TASK_ID] === taskId),
  };
}

/**
 * 合并多个上下文（至少一个），按 artifactId 去重。
 *
 * 骨架取自第一个上下文（sessionId/taskId/parentTaskId）；dependencies 合并去重。
 * 适合调度器将多个 Agent 的返回上下文聚合后下发给依赖方。
 */
export function mergeContexts(...contexts: AgentContext[]): AgentContext {
  if (contexts.length === 0) {
    throw new Error('mergeContexts 需要至少一个上下文');
  }
  const [first, ...rest] = contexts;
  const seen = new Set<string>();
  const artifacts: Artifact[] = [];
  for (const ctx of [first, ...rest]) {
    if (!ctx) continue;
    for (const artifact of ctx.artifacts) {
      if (!seen.has(artifact.id)) {
        seen.add(artifact.id);
        artifacts.push(artifact);
      }
    }
  }
  const dependencies = [...new Set(contexts.flatMap((c) => c.dependencies))];
  return {
    sessionId: first?.sessionId ?? '',
    taskId: first?.taskId ?? '',
    parentTaskId: first?.parentTaskId ?? undefined,
    dependencies,
    artifacts,
  };
}

/**
 * 大小上限保护（返回截断结果而非抛错）。
 *
 * 超出 limitBytes 时从后往前丢弃 artifacts，直到序列化大小不超过上限；
 * 返回的 truncated 标记供调用方决定是否通知用户（修正项 #4）。
 */
export function enforceLimit(
  context: AgentContext,
  limitBytes: number = DEFAULT_CONTEXT_LIMIT_BYTES,
): { context: AgentContext; truncated: boolean } {
  const json = JSON.stringify(context);
  if (utf8Bytes(json) <= limitBytes) {
    return { context, truncated: false };
  }
  const kept: Artifact[] = [];
  for (const artifact of context.artifacts) {
    const candidate: AgentContext = { ...context, artifacts: [...kept, artifact] };
    if (utf8Bytes(JSON.stringify(candidate)) <= limitBytes) {
      kept.push(artifact);
    } else {
      break;
    }
  }
  return { context: { ...context, artifacts: kept }, truncated: true };
}
