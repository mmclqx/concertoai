/**
 * Orchestrator 核心 barrel（v3.0 M1）。
 */

export {
  ARTIFACT_META_FROM_AGENT,
  ARTIFACT_META_MESSAGE_ID,
  ARTIFACT_META_TASK_ID,
  ContextLimitError,
  createArtifact,
  DEFAULT_CONTEXT_LIMIT_BYTES,
  deserialize,
  enforceLimit,
  extractSubset,
  mergeContexts,
  serialize,
} from './context';
export {
  type CoderLike,
  type LoopRoundRecord,
  MAX_LOOP_ATTEMPTS,
  type QaLike,
  qaFailedToIssues,
  type ReviewerLike,
  runTeamLoop,
  type TeamLoopOptions,
  type TeamLoopResult,
} from './loop';
export type {
  FileConflict,
  ScheduleResult,
  SchedulerOptions,
  SchedulerTask,
  TaskRunResult,
  TopoSortResult,
} from './scheduler';
export {
  CyclicDependencyError,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  detectFileConflicts,
  hasDependencyPath,
  TaskScheduler,
  topologicalSort,
} from './scheduler';
export type {
  InvalidTransitionRecord,
  TaskStateChange,
  TaskStateMachineOptions,
  TaskStateRecord,
  TransitionCheck,
  TransitionListener,
  TransitionOptions,
} from './state-machine';
export {
  DEFAULT_MAX_VIOLATIONS,
  InvalidTransitionError,
  isTerminalStatus,
  TaskStateMachine,
  TRANSITIONS,
  TransitionGuardError,
} from './state-machine';
export {
  type RollbackResult,
  SNAPSHOT_ROOT,
  SnapshotManager,
  type TransactionSnapshot,
} from './transaction';
export type {
  AgentContext,
  AgentDef,
  AgentInput,
  AgentInterfaceDef,
  AgentMessage,
  AgentMessageType,
  AgentOutput,
  AgentPermission,
  AgentRuntimeState,
  AgentState,
  AnyAgentMessage,
  Artifact,
  ArtifactType,
  ErrorMessage,
  ErrorPayload,
  FeedbackMessage,
  FeedbackPayload,
  ResultMessage,
  ResultPayload,
  TaskMessage,
  TaskPayload,
  TaskStatus,
} from './types';
export {
  createAgentRuntimeState,
  isErrorMessage,
  isFeedbackMessage,
  isResultMessage,
  isTaskMessage,
} from './types';
