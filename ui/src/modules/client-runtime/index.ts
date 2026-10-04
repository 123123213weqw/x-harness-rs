/// <reference path="./externals.d.ts" />
export type {IWorkCatalog, WorkCatalogSnapshot, WorkSession} from './contract/work-catalog'
/** Browser runtime services for slots, sessions, workspaces, and connection-stream delivery. */
import type { Context } from './context'
import type { ConnectionHandle, SessionId } from '../client-connection/index'
// Type-only: the ctx.remote merge. Deliberately the gateway's Client half rather
// than api-remotes': that face imports a Host-tsdown-generated artifact, and this
// project sits in the Host build graph.
import type {} from '../client-connection/index'
import type { TypertContext } from './remote-contracts'
import type { MaybeSnapshotSelectorHook, SnapshotSelectorHook } from '@xharness/dsh-client-ui-slots'
import { SlotRegistry } from './slots'
import { SessionRuntime } from './sessions/service'
import type { SessionListState } from './sessions/service'
import { WorkspaceRuntime } from './workspaces/service'
import type { ConversationSnapshot } from './sessions/conversation'
import type { UseProjection } from './sessions/projection-store'
import { ConversationEventRegistry } from './conversation/event-registry'
import { ConversationViewRegistry } from './conversation/view-registry'
import {WorkCatalog} from './work/catalog'

export { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '../client-connection/contracts/core/session/surface'

export { SlotRegistry } from './slots'
export { ConversationEventRegistry } from './conversation/event-registry'
export { ConversationViewRegistry } from './conversation/view-registry'
export { ConversationNodeAssembler } from './sessions/conversation-assembler'
export { ConversationLocationIndex } from './sessions/conversation-location-index'
export { conversationContextKey } from './contract/conversation'
export type {
  ChatConversationViewNode, ConversationContextReader, ConversationEventInput,
  ConversationLocationData, ConversationLocationDataScope, ConversationLocationDataStore,
  ConversationStepDataMap,
  ConversationLocation, ConversationMatch, ConversationMatchResult,
  ConversationNodeContext, ConversationNodeDefinition, ConversationPreviousContext,
  ConversationPublication, ConversationTimelineSnapshot, ConversationTurnDataMap, ConversationViewBuilder,
  ConversationViewDefinition, ConversationViewNode, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore, StepLocation, TurnLocation,
} from './contract/conversation'
export type { ConversationRuntime } from './sessions/conversation-assembler'
export type { RootOwnerProps } from './slots'
export { SessionCreateError, SessionRuntime, scopeOf, workspaceTitleOf } from './sessions/service'
export { indexSubagentDescendants } from './sessions/subagent-lineage'
export type { SubagentDescendantSummary } from './sessions/subagent-lineage'
// The provide channel is shared with the client test runtime (one
// materialization/projection implementation; no test-side mirror to drift).
export { SessionProvideChannel } from './sessions/provide'
export type { SessionProvideChannelHost } from './sessions/provide'
export { createScope } from './agents/scope'
export type { AgentScopeHandle } from './agents/scope'
export { DirectoryBrowseError, WorkspaceCreateError, WorkspaceRuntime } from './workspaces/service'
export { abbreviateHomePath, resolveWorkspacePath } from './workspaces/path'
// Contract only: the scope implementation and its Host transport belong to
// dsh-client-ui-settings (see that package's settings-scope.ts).
export type {
  SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec,
} from './contract/settings-scope'
export type { Session } from './sessions/session'
export type { ISession, ProjectionsFace, SessionFace } from './contract/session'
export type { AgentContext, ISessions } from './contract/sessions'
export type { IWorkspaces } from './contract/workspaces'
export type {
  SessionBinding, SessionListState, SessionProvideContribution, SessionProvideDescriptor, SessionSummary,
} from './sessions/service'
export type { SessionListPhase, SessionSearchResultItem, SubagentCatalogSnapshot } from './sessions/manager'
export type { SubagentAddress, JobView } from '../client-connection/index'
export type { WorkspaceListPhase } from './workspaces/manager'
export type { WorkspaceListState } from './workspaces/service'
export type {
  DirectoryEntry, DirectoryListing, WorkspaceId, WorkspaceView,
} from '../client-connection/index'
// Runtime owns the snapshot store; ui-renderer only binds it to React.
export { createSnapshotStore, defineStore, shallowEqual } from './contract/store'
export type {
  EngineStoreHandle, EngineStoreInstance, ObservableSnapshot, SnapshotStore,
} from './contract/store'
export type {
  AssistantBlock, AssistantMessageNode, AssistantProvenanceView, AssistantRequestConfig,
  AssistantTiming, ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot,
  CommandNode, CompactionSummaryNode, ComposerPhase,
  ContextMessageNode, ConversationNode, ConversationSnapshot, ModelRetryNode, QueuedMessage,
  LegacyConversationSlice, PartialAssistant, RunningToolCall,
  SteeringMessageNode, TodoItem, ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode,
  UnknownSurfaceNode, UserMessageNode,
} from './sessions/conversation'
export {
  EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, toAssistantBlock, toAssistantBlocks, publishChatSnapshot,
} from './sessions/conversation'
export { emptyAssistantBlock } from './sessions/partial'
export { isTokenDelta } from './sessions/assistant-timing'
export { contextForm, contextProvenance, sessionRecallLabels } from './sessions/context-provenance'
export { displayFailureMessage } from './sessions/failure-display'
export type {
  ConversationContext, ConversationContextOriginKind,
} from './sessions/conversation-context'
export type {
  ContextProvenanceView, ContextRole, KnownContextForm,
} from './sessions/context-provenance'
export type {
  ConversationPromptSnapshot, RequestInspectionSnapshot, RequestPromptChange, RequestView,
} from './sessions/request-inspection'
export { PendingWait } from './sessions/pending'
export type {
  PendingInteraction, PendingInteractionStatus, PendingKind, PendingPayloads,
} from './sessions/pending'
// Projection value store (push model; see the session-projection subsystem
// page, docs/subsystems/session-projection.md): host-computed
// whole values per key; domains ship projection support with zero client code.
export type {
  ProjectionsBaseline, ProjectionValueStore, SessionProjectionMap, UseProjection,
} from './sessions/projection-store'
export type { SessionId } from '../client-connection/index'

/** Client-side Cordis context after declaration merging. */
export type ClientContext = Context

declare module './remote-contracts' {
  interface TypertContextMap {
    /** Client Agent scope identity; the agent and session share one wire id. */
    agent: TypertContext<SessionId>
  }
}

/** The conversation-snapshot selector hook supplied to session-scoped UI entries. */
export type UseConversationSession = SnapshotSelectorHook<ConversationSnapshot>

declare module '@xharness/dsh-client-ui-slots' {
  /**
   * Session standard kit, real members (ui-slots declares the empty seat;
   * the runtime — where the subjects live — merges the concrete types):
   * every session-scope slot component receives these from the framework.
   */
  interface SessionStandardProps {
    useSession: SnapshotSelectorHook<ConversationSnapshot>
    /** The framework-resolved session id (owners never pass it). */
    sessionId: SessionId
    /** The fifth framework hook seat: key-addressed projection reader (undefined = capability absent). */
    useProjection: UseProjection
  }
  /** Standard kit for slots that remain mounted while current session changes. */
  interface SessionMaybeStandardProps {
    useSession: MaybeSnapshotSelectorHook<ConversationSnapshot>
    /** Current session id; absent in the no-session state. */
    sessionId: SessionId | undefined
    /** Key-addressed projection reader; every key reads absent while no session is current. */
    useProjection: UseProjection
  }
  /** Props injected into every global slot component. */
  interface GlobalStandardProps {
    useSessions: SnapshotSelectorHook<SessionListState>
    /** Selector hook over real Workspaces and their independent baseline lifecycle. */
    useWorkspaces: SnapshotSelectorHook<import('./workspaces/service').WorkspaceListState>
  }
}

/** Required services: the wire handle and Client Typert registry. */
export const inject = ['connection', 'typert', 'remote', 'remote.commands']

/** Mounts the browser runtime services and connection stream.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(SlotRegistry)
  const conversation = {
    events: new ConversationEventRegistry(ctx),
    views: new ConversationViewRegistry(ctx),
  }
  const connection = ctx.get('connection')
  if (connection === undefined) throw new Error('runtime: connection service is unavailable')
  const sessions = new SessionRuntime(ctx, connection.api, ctx.remote, conversation)
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => sessions.scopeOf(candidate),
  })
  const workspaces = new WorkspaceRuntime(ctx, connection.api, sessions)
  const workCatalog = new WorkCatalog(connection.api, sessions, workspaces)
  ctx.reflect.provide('workCatalog', workCatalog, undefined)
  ctx.effect(() => () => workCatalog.dispose(), 'runtime: Work catalog projection')
  ctx.effect(
    () => workspaces.startInitialSelection(),
    'runtime: initial Workspace selection',
  )
  const loop = connection.start({
    onMuxEnvelope: (envelope) => {
      sessions.handleMuxEnvelope(envelope)
    },
    onHostEnvelope: (envelope) => {
      sessions.handleHostEnvelope(envelope)
      workspaces.handleHostEnvelope(envelope)
      // Forwarded-event bridge: the session layer ignores registry frames (no
      // session routing). This plugin owns the frame sink, so it hands the
      // decoded frame straight to the Remote service, which fans it out to
      // `ctx.remote.$on` subscribers; no consumer reads a frame.
      const frame = envelope.payload
      if (frame.type === 'host/remote-event') ctx.remote.$dispatch(frame.event, frame.args)
    },
    onConnected: () => {
      sessions.handleConnected()
      workspaces.handleConnected()
      ctx.emit('connection/reset')
    },
    onStateChange: (state) => {
      // Generation death fires before any next-generation frame can arrive
      // (reconnect replays flow from stream open, ahead of onConnected):
      // the only safe moment to drop generation-scoped interaction state.
      if (state === 'reconnecting') {
        sessions.handleDisconnected()
      }
    },
  })
  ctx.effect(() => () => { loop.stop() }, 'runtime: connection stream loop')
}
