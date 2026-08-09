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
