/**
 * 标准 Agent 接口契约（v3.0 M1 / T1.2，接口优先 §3.1）。
 *
 * 所有内置与第三方 Agent 实现本接口，保证可插拔、可替换、可测试：
 * - 输入/输出符合 AgentDef.interfaces 声明的 zod Schema（运行时校验 + 编译期推导）；
 * - 支持运行时状态（AgentRuntimeState）与消息收发（send/receive）；
 * - 类型与 T1.1（src/orchestrator/types.ts）一致，不重复定义。
 */

import type { z } from 'zod';
import type {
  AgentContext,
  AgentDef,
  AgentMessage,
  AgentRuntimeState,
  AnyAgentMessage,
} from '../orchestrator';

/** 标准 Agent 的输入静态类型（从 AgentDef.interfaces 推导）。 */
export type AgentInput<TDef extends AgentDef> = z.infer<TDef['interfaces']['input']>;

/** 标准 Agent 的输出静态类型（从 AgentDef.interfaces 推导）。 */
export type AgentOutput<TDef extends AgentDef> = z.infer<TDef['interfaces']['output']>;

/** 消息处理结果：Agent 接收并处理一条消息后的可选回复。 */
export interface AgentReply {
  /** 回复消息（无回复时缺省）。 */
  message?: AnyAgentMessage;
}

/**
 * 标准 Agent 契约。
 *
 * @template TDef AgentDef 子类型（默认 AgentDef，此时输入/输出为 unknown）。
 */
export interface Agent<TDef extends AgentDef = AgentDef> {
  /** Agent 定义（注册表契约：名称/版本/接口 Schema/权限声明）。 */
  readonly def: TDef;

  /** 运行时状态（ADR-016 修正项 #3：与任务级 AgentState 解耦）。 */
  runtimeState: AgentRuntimeState;

  /**
   * 执行核心：输入先经 interfaces.input schema 校验，处理完成后输出经
   * interfaces.output schema 校验。输入不合法应抛错（由调用方/调度器捕获）。
   *
   * @param input   符合 AgentDef.interfaces.input 的结构化输入。
   * @param context 显式上下文（§3.3，随消息传递的任务上下文）。
   */
  execute(
    input: z.infer<TDef['interfaces']['input']>,
    context: AgentContext,
  ): Promise<z.infer<TDef['interfaces']['output']>>;

  /** 发送结构化消息给其他 Agent（显式上下文随消息传递，§3.3）。 */
  send(message: AgentMessage): Promise<void>;

  /** 接收并处理一条消息，返回可选回复（task→result / feedback→修复 等闭环驱动）。 */
  receive(message: AnyAgentMessage): Promise<AgentReply | undefined>;
}
