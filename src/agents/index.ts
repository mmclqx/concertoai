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
  CoderAgent,
  type CoderAgentOptions,
  type CoderApproval,
  type CoderFile,
  type CoderFileWriter,
  type CoderInput,
  type CoderOutput,
  coderInputSchema,
  coderOutputSchema,
  DiskFileWriter,
  diffForWrite,
  generateFix,
  generateImplementation,
  parseCoderOutput,
} from './coder';
export {
  artifactTypeForAgent,
  decomposeRequirement,
  Orchestrator,
  OrchestratorDecomposeError,
  type OrchestratorOptions,
  type OrchestratorRunResult,
  type OrchestratorTask,
  parseOrchestratorTasks,
  type TaskExecution,
} from './orchestrator';
export type { Agent, AgentInput, AgentOutput, AgentReply } from './protocol';
export {
  buildQaSummary,
  ChildProcessQaRunner,
  type ChildProcessQaRunnerOptions,
  DEFAULT_VERIFY_TIMEOUT_MS,
  formatFeedbackIssues,
  parseVerifyOutput,
  QaAgent,
  type QaAgentOptions,
  type QaFailedItem,
  type QaInput,
  type QaReport,
  type QaRunner,
  type QaRunResult,
  qaReportSchema,
} from './qa';
export type { AgentEntry, AgentRegistry } from './registry';
export { InMemoryAgentRegistry } from './registry';
export {
  type AutoFixLike,
  type ReviewEngineLike,
  type ReviewInput,
  reviewResultSchema,
  TeamReviewerAgent,
  type TeamReviewerOptions,
} from './reviewer';
