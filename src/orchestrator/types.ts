/**
 * Orchestrator 核心协议类型定义（v3.0 M1，接口优先 §3.1）。
 *
 * 定义多 Agent 团队的全部通信契约：消息载体（AgentMessage）、显式上下文
 * （AgentContext / Artifact）、Agent 角色定义（AgentDef / AgentPermission）与
 * 状态表示（AgentState / TaskStatus / AgentRuntimeState）。
 *
 * 依据 ADR-016（T0.2 评审定稿）落实 5 项 M1 修正项：
 *  #1 payload 泛型化（AgentMessage<TPayload = unknown>）+ 判别联合消息
 *  #2 AgentDef.interfaces 使用 zod schema 对象（运行时校验 + 编译期推导）
 *  #3 AgentState = 任务级状态机状态；AgentRuntimeState 单独定义（lastError/attempts）
 *  #4 Artifact 大小保护由 T1.3 上下文管理器负责（64KB 上限 + 按 taskId 子集提取）
 *  #5 permissions 工具名级别 + 可选参数约束（对齐 ADR-004 fail-closed）
 */

import type { z } from 'zod';

// ── 消息类型 ──────────────────────────────────────────────────

/** Agent 消息类型（结构化通信四种语义）。 */
export type AgentMessageType = 'task' | 'result' | 'error' | 'feedback';

// ── Payload 类型 ─────────────────────────────────────────────

/** task 消息负载：下发一个任务给目标 Agent。 */
export interface TaskPayload {
  /** 任务描述（自然语言，供 Agent 理解目标）。 */
  description: string;
  /** 显式声明的任务依赖（taskId 列表）。 */
  dependencies: string[];
}

/** result 消息负载：Agent 完成任务后返回的结构化结果。 */
export interface ResultPayload {
  /** 结构化结果数据（由 Agent 实现定义具体形状）。 */
  data: unknown;
}

/** error 消息负载：Agent 执行失败的错误信息。 */
export interface ErrorPayload {
  /** 错误描述（中文）。 */
  message: string;
  /** 可选错误码（便于程序化处理）。 */
  code?: string;
}

/** feedback 消息负载：Reviewer/QA 对 Coder 的反馈（闭环修复驱动）。 */
export interface FeedbackPayload {
  /** 问题列表（如 ReviewIssue 序列化后的摘要条目）。 */
  issues: string[];
}

// ── AgentMessage（泛型消息载体）──────────────────────────────

/**
 * Agent 之间双向传递的结构化消息（修正项 #1）。
 *
 * 默认 `TPayload = unknown`（与 T0.2 评审一致）；需要精确 payload 时
 * 可指定泛型参数，或使用下方判别联合消息（TaskMessage 等）获得运行时收窄。
 */
export interface AgentMessage<TPayload = unknown> {
  /** 消息 ID（全局唯一，可观测性/审计日志引用）。 */
  id: string;
  /** 发送者 Agent 名称。 */
  from: string;
  /** 接收者 Agent 名称。 */
  to: string;
  /** 消息类型（task/result/error/feedback）。 */
  type: AgentMessageType;
  /** 类型化负载（默认 unknown，见 ADR-016 修正项 #1）。 */
  payload: TPayload;
  /** 显式上下文（非隐式注入，见 §3.3）。 */
  context: AgentContext;
  /** 消息时间戳（epoch 毫秒）。 */
  timestamp: number;
}

// ── 判别联合消息（修正项 #1 补充：运行时分派）───────────────

/** task 消息（类型收窄为 'task'）。 */
export interface TaskMessage extends AgentMessage<TaskPayload> {
  type: 'task';
}

/** result 消息（类型收窄为 'result'）。 */
export interface ResultMessage extends AgentMessage<ResultPayload> {
  type: 'result';
}

/** error 消息（类型收窄为 'error'）。 */
export interface ErrorMessage extends AgentMessage<ErrorPayload> {
  type: 'error';
}

/** feedback 消息（类型收窄为 'feedback'）。 */
export interface FeedbackMessage extends AgentMessage<FeedbackPayload> {
  type: 'feedback';
}

/** 判别联合：按 type 字段可运行时收窄的完整消息集。 */
export type AnyAgentMessage = TaskMessage | ResultMessage | ErrorMessage | FeedbackMessage;

// ── 类型守卫（供 loop / scheduler / trace 分派使用）──────────

/** 判断消息是否为 task 类型（运行时收窄）。 */
export function isTaskMessage(msg: AgentMessage): msg is TaskMessage {
  return msg.type === 'task';
}

/** 判断消息是否为 result 类型（运行时收窄）。 */
export function isResultMessage(msg: AgentMessage): msg is ResultMessage {
  return msg.type === 'result';
}

/** 判断消息是否为 error 类型（运行时收窄）。 */
export function isErrorMessage(msg: AgentMessage): msg is ErrorMessage {
  return msg.type === 'error';
}

/** 判断消息是否为 feedback 类型（运行时收窄）。 */
export function isFeedbackMessage(msg: AgentMessage): msg is FeedbackMessage {
  return msg.type === 'feedback';
}

// ── Artifact（工件）──────────────────────────────────────────

/** 工件类型：spec / code / 测试报告 / 审查结果 / 通用文件。 */
export type ArtifactType = 'spec' | 'code' | 'test-report' | 'review-result' | 'file';

/**
 * 已产出的工件（文件、设计文档等）。
 * 大小保护由 T1.3 上下文管理器负责（64KB 上限 + 按 taskId 子集提取，修正项 #4）。
 */
export interface Artifact {
  /** 工件 ID（全局唯一）。 */
  id: string;
  /** 工件类型。 */
  type: ArtifactType;
  /** 关联文件路径（可选，虚拟工件如 spec 可无路径）。 */
  path?: string;
  /** 工件内容（文本）。 */
  content: string;
  /** 元数据（如产生它的 Agent 名、消息 id、尺寸等，供来源追踪）。 */
  metadata: Record<string, unknown>;
}

// ── AgentContext（显式上下文）────────────────────────────────

/**
 * 显式上下文：随消息传递的结构化上下文（§3.3）。
 * 不使用隐式全局状态，所有数据流可追溯、可测试、可审计。
 */
export interface AgentContext {
  /** 会话 ID（一次 Orchestrator 运行一个会话）。 */
  sessionId: string;
  /** 任务 ID（上下文归属的任务）。 */
  taskId: string;
  /** 父任务 ID（子任务场景）。 */
  parentTaskId?: string;
  /** 依赖任务 ID 列表。 */
  dependencies: string[];
  /** 已产出的工件列表（按需传递，T1.3 支持子集提取）。 */
  artifacts: Artifact[];
}

// ── AgentDef（Agent 角色定义）────────────────────────────────

/**
 * Agent 接口 Schema（修正项 #2）。
 * 使用 zod schema 对象：运行时校验（T4.2 市场合规检查复用）+
 * 编译期推导（z.infer）。version 为接口版本号，保证可插拔兼容。
 */
export interface AgentInterfaceDef {
  /** 输入 Schema（zod 对象，运行时校验 + 编译期推导）。 */
  input: z.ZodTypeAny;
  /** 输出 Schema（zod 对象，运行时校验 + 编译期推导）。 */
  output: z.ZodTypeAny;
  /** 接口版本号（semver，升级兼容判定用）。 */
  version: string;
}

/** 从 AgentDef 推导输入静态类型。 */
export type AgentInput<T extends AgentDef> = z.infer<T['interfaces']['input']>;
/** 从 AgentDef 推导输出静态类型。 */
export type AgentOutput<T extends AgentDef> = z.infer<T['interfaces']['output']>;

/**
 * 工具权限声明（修正项 #5：工具名级别 + 可选参数约束）。
 * 对齐 ADR-004 fail-closed：未声明的工具一律拒绝；args 用于细粒度约束。
 */
export interface AgentPermission {
  /** 工具名（如 'edit_file' / 'run_command' / 'read_file'）。 */
  tool: string;
  /** 可选参数约束（键 = 参数名，值 = 允许值或模式，缺省 = 该工具全部参数可用）。 */
  args?: Record<string, unknown>;
}

/**
 * Agent 角色定义（市场注册 / 审批流 / 接口合规检查的契约）。
 * 第三方 Agent 必须提供完整 AgentDef 才能被 AgentRegistry 接受（T1.2）。
 */
export interface AgentDef {
  /** Agent 标识名（注册表唯一）。 */
  name: string;
  /** Agent 版本号（semver）。 */
  version: string;
  /** 输入/输出 Schema 契约。 */
  interfaces: AgentInterfaceDef;
  /** 工具权限声明列表（审批流按此授予最小权限）。 */
  permissions: AgentPermission[];
}

// ── 状态表示（修正项 #3）─────────────────────────────────────

/** 任务生命周期状态（T2.1 状态机消费）。 */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'awaiting_review'
  | 'awaiting_qa'
  | 'completed'
  | 'failed';

/** 任务级状态机状态（与 AgentRuntimeState 解耦，见 ADR-016 修正项 #3）。 */
export interface AgentState {
  /** 当前任务状态。 */
  status: TaskStatus;
  /** 所属任务 ID。 */
  taskId: string;
  /** 当前负责的 Agent 名称（未分配时为空字符串）。 */
  agent: string;
}

/** Agent 运行时状态（与任务级状态机解耦，供调度/重试逻辑消费）。 */
export interface AgentRuntimeState {
  /** 上次错误信息（最近一次失败原因）。 */
  lastError?: string;
  /** 已尝试次数（重试上限 2 次，T2.2 消费）。 */
  attempts: number;
  /** 状态最后更新时间戳（epoch 毫秒）。 */
  updatedAt: number;
  /** 最近一次可见上下文（调试/可观测性）。 */
  lastContext?: AgentContext;
}

/** 初始 Agent 运行时状态（attempts=0，updatedAt=当前时间）。 */
export function createAgentRuntimeState(): AgentRuntimeState {
  return { attempts: 0, updatedAt: Date.now() };
}
