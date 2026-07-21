/**
 * apiproxy contract-layer barrel. api/ has zero Node dependencies and is
 * importable from the browser; the TS interfaces are the authoritative contract, while HTTP,
 * WebSocket, and in-process SSE are merely physical channels (four-quadrant message model).
 */

import type { SessionsApi } from './sessions'
import type { HostApi } from './host'
import type { WorkspaceApi } from './workspace'
import type { AgentPresetsApi } from './agent-presets'
import type { SkillsApi } from './skills'
import type { SubagentsApi } from './subagents'
import type { EventsApi } from './events'
import type { GoalsApi } from './goals'
import type { SettingsApi } from './settings'
import type { CredentialsApi } from './credentials'
import type { LlmApi } from './llm'
import type { DownloadsApi } from './downloads'
import type { ClientResponse, RpcReceipt } from './rpc'

/** Root interface of the unified API. New client-request domain = one new file pair + one field here + one map row. */
export interface ApiProxy {
  sessions: SessionsApi
  subagents: SubagentsApi
  host: HostApi
  workspace: WorkspaceApi
  skills: SkillsApi
  agentPresets: AgentPresetsApi
  events: EventsApi
  goals: GoalsApi
  settings: SettingsApi
  credentials: CredentialsApi
  llm: LlmApi
  /** Host-only download surfaces (GET, no wire envelope); absent from IApiClient. */
  downloads: DownloadsApi
  /**
   * Response entry for server requests; not a domain method.
   * @param message - Client response carrying the server request's rpcId.
   * @returns Transport receipt for the response delivery.
   */
  respond(message: ClientResponse): Promise<RpcReceipt>
}

// ---- Domain interfaces and payload entities ----
export type {
  HistoryEntry, ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelSelection, PromptContentPart, QueueAction, SessionModels,
  SessionListMetadata, SessionProjectionsBlock, SessionSearchItem, SessionsApi, SessionSummary,
} from './sessions'
export type { DirectoryEntry, DirectoryListing, HostApi } from './host'
export type {
  SubagentAddress, SubagentCatalog, SubagentInterruptReceipt, SubagentListEntry,
  SubagentPromptReceipt, SubagentsApi,
} from './subagents'
export type { JobView } from './jobs'
export type { WorkspaceApi, WorkspaceId, WorkspaceView, ArchivedSessionSummary } from './workspace'
export type { SkillsApi, SkillEntry } from './skills'
export type { AgentPresetsApi, AgentPresetEntry } from './agent-presets'
export type { EventsApi, MuxFrame, HostFrame, QueuedInboxItem, ToolCallView, ToolEventView, ToolResultView } from './events'
export type { GoalsApi, GoalId, GoalRef } from './goals'
export type { SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView } from './settings'
export type { CredentialsApi, CredentialView } from './credentials'
export type { ConfigurableProviderView, DiscoveredModelView, LlmApi } from './llm'
export type { DownloadsApi } from './downloads'
export type { ApprovalResponsePayload } from './approvals'

export type { QuestionResponsePayload } from './questions'

// ---- Message layer: narrow forms (domain-signature view) ----
export type { RpcRequest, RpcResponse } from './rpc'

// ---- Message layer: the four wire full forms + carrier receipt ----
export type {
  ClientRequest,
  ClientResponse,
  RpcMessage,
  RpcReceipt,
  ServerRequest,
  ServerResponse,
} from './rpc'

// ---- Errors and ids ----
export { RpcId, transportError } from './rpc'
export type { RpcError, RpcErrorCode, RpcErrorDetailsMap, RpcResult } from './rpc'
export {
  clientRequestSchema,
  serverRequestSchema,
  serverResponseSchema,
} from './rpc.schema'

// ---- Fixed session-search product bounds ----
export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './session-search'

// ---- Method registry and derived generics ----
export type { RequestPayload, ResponseValue, RpcMethodMap } from './rpc-map'
