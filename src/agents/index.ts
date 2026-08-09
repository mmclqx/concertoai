/**
 * Agent 系统 barrel（v3.0 M1，升级自 v2.1 src/agent/）。
 */

export {
  ArchitectAgent,
  type ArchitectAgentOptions,
  type ArchitectFile,
  type ArchitectInterface,
  type ArchitectSpec,
  architectSpecSchema,
  generateArchitectSpec,
  parseArchitectSpec,
} from './architect';
export {
  artifactTypeForAgent,
  decomposeRequirement,
  Orchestrator,
  type OrchestratorOptions,
  type OrchestratorRunResult,
  type OrchestratorTask,
  parseOrchestratorTasks,
  type TaskExecution,
} from './orchestrator';
export type { Agent, AgentInput, AgentOutput, AgentReply } from './protocol';
export type { AgentEntry, AgentRegistry } from './registry';
export { InMemoryAgentRegistry } from './registry';
