/**
 * Agent 系统 barrel（v3.0 M1，升级自 v2.1 src/agent/）。
 */

export type { Agent, AgentInput, AgentOutput, AgentReply } from './protocol';
export type { AgentEntry, AgentRegistry } from './registry';
export { InMemoryAgentRegistry } from './registry';
