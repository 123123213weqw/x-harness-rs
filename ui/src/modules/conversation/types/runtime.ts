/** Narrow runtime carrier consumed by the conversation plugin. */
import type * as React from 'react'
import type { IConversation, ConversationController } from '../service'
import type { ChatFileMentions } from '../contract/slots'
import type { BeginCommandRequest, InsertReferenceRequest, InsertTextRequest, ConsumeTokenRequest, InputTriggerController, SubmitImageAttachment } from './triggers'
import type { InputActions, InputState } from '../input/contract'
import type { SessionId, WorkspaceId, RpcResult, ImageAttachmentRef, PermissionSelect, TodoItem, TokenUsageProjection, ContextPressureProjection } from './wire'
import type { ConversationSnapshot } from './model'
import type { ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode } from './events'
import type { Translation as SharedTranslation } from '../../shared/runtime-types'
export * from './wire'
export * from './model'
export * from './events'
export type { KnownContextForm } from './context-provenance'
export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface SnapshotStore<T> extends ObservableSnapshot<T> { set(value: T): void; update(edit: (draft: T) => void): void }
export interface EngineStoreHandle<T, A> { readonly spec: { init(): T; actions: A; persist?: (string) | undefined } }
export interface SettingsScope<T> extends ObservableSnapshot<{ value: T | undefined; writable: boolean }> { set(field: string, value: unknown): Promise<void> }
export interface PendingPayloads {
 approval: { reviewing?: boolean | undefined; toolName: string; approvalId: string; reason?: (string) | undefined; callId?: (string) | undefined }
 question: { [key: string]: unknown }
}
export interface PendingWait<K extends keyof PendingPayloads = keyof PendingPayloads> { readonly kind: K; readonly key: string; readonly sessionId: SessionId; readonly payload: PendingPayloads[K]; respond(result: RpcResult<unknown>): Promise<{ accepted: boolean; reason?: (string) | undefined }> }
export type PendingInteraction = { [K in keyof PendingPayloads]: PendingWait<K> }[keyof PendingPayloads]
export interface SessionSummary { id: string; displayTitle: string; origin?: (string) | undefined; parentId?: (string) | undefined; cwd?: (string) | undefined; blank: boolean; running?: (boolean) | undefined }
export interface SessionListState { current: string | undefined; byId: Readonly<Record<string, SessionSummary | undefined>> }
export interface WorkspaceListState { phase: string; items: readonly { workspaceId: string; title: string; sessionIds: readonly string[] }[] }
export type QueueAction = { kind: 'steer' | 'remove' } | { kind: 'edit'; content: readonly { type: 'text'; text: string }[] }
export type PromptPart = { type: 'text'; text: string } | { type: 'image' | 'file'; mediaType: string; data: string; name?: (string) | undefined } | { type: 'image_ref' | 'file_ref'; attachmentId: string; name?: (string) | undefined }
export interface SessionFace extends ObservableSnapshot<ConversationSnapshot> {
 readonly sessionId: string
 prompt(parts: PromptPart[], mode: 'queue' | 'steer', signal?: AbortSignal, policy?: { requireIdle: boolean }): Promise<RpcResult<{ accepted: true }>>
 command(line: string): Promise<RpcResult<{ matched: boolean }>>
 cancel(): Promise<RpcResult<{ accepted: true }>>
 loadOlder(): Promise<void>
 readAttachment(id: string): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>>
 updateQueue(id: string, action: QueueAction): Promise<RpcResult<{ accepted: true }>>
}
export interface SessionBinding { sessionId: string; session: SessionFace; ctx: ClientContext }
export interface ISessions {
 list: ObservableSnapshot<SessionListState>
 scopeOf(ctx: ClientContext | import('@xharness/cordis').Context): string | undefined
 scope(id: string): ClientContext | undefined
 binding(id: string): SessionBinding | undefined
 open(id: string): void
 fork(input: { sessionId: string; atSeq?: (number) | undefined; beforeUserSeq?: (number) | undefined; increaseTitle: boolean }): Promise<string>
 provide(spec: { hooks: readonly string[]; props: readonly string[]; resolve(binding: SessionBinding): { hooks: { input: ObservableSnapshot<InputState> }; props: { inputActions: InputActions } } }): () => void
}
export interface ProjectionMap {
 permissions: PermissionSelect
 plan: { active: boolean; pending: boolean }
 goal: unknown
 todos: readonly TodoItem[]
 tokenUsage: TokenUsageProjection
 contextPressure: ContextPressureProjection
 contextBreakdown: { systemTokens: number; toolsTokens: number; messageTokens: number }
 sessionStats: { turns: number; steps: number; llmMs: number; toolMs: number; ttftMs: number; ttftSteps: number; decodeMs: number; decodeTokens: number }
 imageLimits: import('./wire').ImageAttachmentLimits
 attachmentLimits: { images: { maxCount: number; maxBytes: number } }
}
export interface UseProjection { <K extends keyof ProjectionMap>(key: K): ProjectionMap[K] | undefined; <K extends keyof ProjectionMap, T>(key: K, select: (value: ProjectionMap[K] | undefined) => T): T }
export interface Slots {
 inject(name: string, effect: () => void | (() => void)): void
 register<P, Args extends readonly unknown[] = readonly [], Owner = object>(spec: { name: string; id?: string; key?: string; order?: number; priority?: number; locale?: string; label?: string | (() => string); select?: (owner: Owner) => unknown; inject?: (...args: Args) => unknown; store?: unknown; children?: Readonly<Record<string, { kind: string; scope: string; inject?: unknown }>> }, component: React.ComponentType<P>): () => void
 entries(name: string): readonly { options: { id?: (string) | undefined; label?: (string | (() => string)) | undefined } }[]
 subscribe(name: string, listener: () => void): () => void
 getVersion(name: string): number
}
export interface InputEventMap {
 'slash/input-begin-command': BeginCommandRequest
 'slash/input-insert-reference': InsertReferenceRequest
 'slash/input-consume-token': ConsumeTokenRequest
 'slash/input-insert-text': InsertTextRequest
}
export interface ServiceMap { sessions: ISessions; conversation: ConversationController; inputTriggers: { sessionOf(ctx: ClientContext): InputTriggerController | undefined }; commandUi: import('../input/hub').CommandFace; chatFileMentions: ChatFileMentions }
export interface ClientContext {
 sessions: ISessions
 workspaces: { connectWorkspace(id: WorkspaceId): Promise<SessionId>; openPath(path: string): Promise<void> }
 slots: Slots
 locale: { register(namespace: string, labels: { en: Readonly<Record<string, string>>; zh: Readonly<Record<string, string>> }): () => void; bind(namespace: string): (key: string, params?: Record<string, unknown>) => string }
 layout: { openDetails(): void; closeDetails(): void }
 settingsScope: { bind<T>(input: { namespace: string }): SettingsScope<T> }
 conversationEvents: { register<S>(definition: ConversationNodeDefinition<S>): void; registerFallback<S>(definition: ConversationNodeDefinition<S>): void }
 conversationViews: { register<N extends ConversationViewNode, S>(definition: ConversationViewDefinition<N, S>): void }
 effect(effect: () => void | (() => void), label: string): void
 get<K extends keyof ServiceMap>(name: K): ServiceMap[K] | undefined
 on<K extends keyof InputEventMap>(event: K, listener: (request: InputEventMap[K]) => true | undefined): () => void
 plugin<T, C>(service: new (context: ClientContext, config: C) => T, config: C): void
 plugin(plugin: { name: string; inject: readonly string[]; apply(context: ClientContext): void }): void
}
export type Context = ClientContext
