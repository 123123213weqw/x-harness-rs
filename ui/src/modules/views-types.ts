/** Owned, deliberately small contracts for migrated view contributors. */
import type * as React from 'react'
import type { DeliverablesTurnData } from './deliverables/turn-deliverables'

export type SessionId = string
export type Translation = (key: string, values?: Readonly<Record<string, string | number>>) => string
export type TranslateNS<_Namespace extends string> = Translation
export interface PropsLocale<_Namespace extends string> { t: Translation }
export interface JobView {
  id: string; kind: string; label: string; status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  startedAt: number; finishedAt?: number; detail?: string
}
export interface SessionSnapshot {
  jobsBySession: Readonly<Record<SessionId, readonly JobView[] | undefined>>
  current?: string
  byId: Readonly<Record<SessionId, { blank: boolean } | undefined>>
}
export interface PropsRuntime<Seat extends string> {
  sessionId: SessionId
  useSessions<T>(select: (state: SessionSnapshot) => T): T
  useProjection(name: 'plan'): { active: boolean; pending: boolean } | undefined
  locked: boolean
}
export type InjectFace<Face> = Face extends { hooks: { hostDescription: HostDescriptionSource } }
  ? Omit<Face, 'hooks'> & { useHostDescription<T>(select: (value: HostDescription | undefined) => T): T }
  : Face
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } }
export interface SkillEntry { name: string; description: string; modelInvocable: boolean }
export interface FileReferenceCandidate { kind: 'file' | 'directory'; path: string }
export interface SessionReferenceMentionCandidate {
  sessionId: string; label: string; mention: string; createdAt: number; cwd?: string
}
export interface ClientSessionContext { sessionId: SessionId }
export interface InputCandidate { name: string; description?: string; section?: string; value?: string }
export interface InputTriggerSource {
  trigger: string; name: string; order?: number; showGroupTitle?: boolean
  candidates(session: ClientSessionContext, query: { query: string; quoted?: boolean; signal: AbortSignal }): Promise<readonly InputCandidate[]>
  warm?(session: ClientSessionContext): void
  lexicon?(session: ClientSessionContext): readonly string[] | undefined
  subscribeLexicon?(session: ClientSessionContext, listener: () => void): () => void
  onPick(input: { candidate: InputCandidate }): { text: string; continue?: boolean } | {
    insert: { source: string; ref: string; label: string; appearance: string; clipboardText: string }
  } | undefined
  codec?: { clipboardText(ref: string): string; serialize(ref: string): Promise<string> }
}
export interface InputTriggerServiceContract { registerSource(source: InputTriggerSource): () => void }
export interface ISessions { subagentAddress(sessionId: SessionId): unknown | undefined }
export interface HostDescription { canOpenPath?: boolean }
export interface HostDescriptionSource { getSnapshot(): HostDescription | undefined; subscribe(listener: () => void): () => void }
export interface ConnectionHandle {
  isLoopback: boolean; hostDescription: HostDescriptionSource
  api: { skills: { list(input: { sessionId: SessionId }, signal: AbortSignal): Promise<{ result: ApiResult<{ skills: readonly SkillEntry[] }> }> } }
}
export interface ToolCallBlock { callId: string; argsRaw: string }
export interface ToolResultBlock {
  kind: string; callId: string; call?: { argsRaw?: string }; isError?: boolean
  error?: { name: string; code: string }
  content: readonly ({ type: 'text'; text: string } | { type: 'image'; [key: string]: unknown })[]
}
export interface ToolCallViewProps { block: ToolCallBlock | ToolResultBlock; inspect?: () => void }
export interface HeroBrandMarkOwnerProps { size?: number | undefined; className?: string | undefined }
export interface SidebarBrandMarkOwnerProps extends HeroBrandMarkOwnerProps {}
export interface MarkdownFileMentions { resolve(value: string): { open(): void; label: string; title: string } | undefined }
export interface TurnTailOwnerProps {
  seq: number; openFile(path: string): void
  turn: { data: { get(key: 'deliverables'): Readonly<DeliverablesTurnData> | undefined } }
}
export interface ChatFileMentions { forClosing(owner: TurnTailOwnerProps): MarkdownFileMentions | undefined }
export interface ToolResultNode { callView: { card: string; kind?: string; locations?: readonly { path: string }[] } | null }
export type ConversationEvent =
  | { type: 'turn/start'; seq: number; time: number; data: { turn: number } }
  | { type: 'tool/call'; seq: number; time: number; data: { turn: number; callId: string } }
  | { type: 'tool/result'; seq: number; time: number; surface?: 'append' | 'replace'; data: { turn: number; message: {
    source: { callId: string }; content: readonly [{ isError?: boolean }, ...unknown[]]
  } } }
  | { type: 'other'; seq: number; time: number; data: { turn: number } }
  | { type: 'command/run'; seq: number; time: number; data: { name: string; commandId: string; args?: string } }
export type CommandId = string
export type SessionEvent<Type extends ConversationEvent['type']> = Extract<ConversationEvent, { type: Type }>
export interface DefinitionMatch { event: ConversationEvent; view?: { for: 'call' | 'result'; view: ToolResultNode['callView'] } }
export interface ConversationNodeDefinition<State> {
  kind: string
  target?: 'chat'
  match(event: ConversationEvent): { id: string; role: 'start' | 'update' } | null
  start(context: unknown, match: DefinitionMatch): State
  update(context: { state: State }, match: DefinitionMatch): State
  buildLocationData?(context: { state?: State }, scope: string): { kind: string; turn: number; key: string; value: unknown } | null
  buildViewNode?(context: { state?: State; key: string; id: string; start?: { location: unknown } }): {
    key: string; kind: string; id: string; target: string; anchorSeq: number; location: unknown; visibility: string; data: unknown
  } | null
}
export interface SlotsService {
  inject(name: string, effect: () => void | (() => void) | Iterable<unknown>): void
  register<P, Args extends readonly unknown[], Owner>(spec: {
    name: string; id?: string; key?: string; order?: number; priority?: number; locale?: string; label?: string | (() => string)
    select?: (owner: Owner) => unknown
    inject?: (...args: Args) => unknown
    store?: (() => unknown) | EngineStoreHandle<unknown, object>
    children?: Readonly<Record<string, { kind: 'single' | 'list' | 'keyed'; scope: string }>>
  }, component: React.ComponentType<P>): () => void
}
export interface ClientContext {
  effect(effect: () => void | (() => void), label: string): void
  locale: { register(namespace: string, translations: { zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>> }): void; bind(namespace: string): Translation }
  slots: SlotsService
  get(name: 'connection'): ConnectionHandle
  get(name: 'sessions'): ISessions
  get(name: 'inputTriggers'): InputTriggerServiceContract
  on(name: 'connection/reset', callback: () => void): () => void
  on(name: 'theme/change', callback: (snapshot: ThemeSnapshot) => void): () => void
  remote: {
    $on(name: 'agent-preset/selected', callback: (sessionId: SessionId) => void): () => void
    commands: { execute(sessionId: SessionId, command: string, args: readonly unknown[]): Promise<ApiResult<unknown>> }
    fileReferences: { list(sessionId: SessionId, query: string, signal: AbortSignal): Promise<ApiResult<readonly FileReferenceCandidate[]>> }
    sessionReferenceResolver: { candidates(sessionId: SessionId, query: string, signal: AbortSignal): Promise<ApiResult<readonly SessionReferenceMentionCandidate[]>> }
  }
  conversationEvents: { register<State>(definition: ConversationNodeDefinition<State>): void }
  provide(name: 'chatFileMentions', value: ChatFileMentions): void
  workspaces: { startSession(workspaceId?: string): void }
  layout: { toggleSidebar(): void }
  reflect: { provide(name: 'layout', value: { toggleSidebar(): void; openDetails(): void; closeDetails(): void }): () => void | Promise<void> }
  theme: { getTheme(): ThemeSnapshot }
}
export interface ThemeSnapshot { active: { colorScheme: 'light' | 'dark'; tokens: Readonly<Record<string, string>> } }
export interface EngineStoreHandle<State, Actions> { readonly spec: { init(): State; actions: Actions } }
export type BoundActions<Handle> = Handle extends EngineStoreHandle<unknown, infer Actions> ? {
  [Name in keyof Actions]: Actions[Name] extends (state: never, ...args: infer Args) => void ? (...args: Args) => void : never
} : never
export interface PropsStore<_Handle> {}
export interface PropsRenderSlots<_Seat extends string> {
  renderSlot(name: string, owner: Readonly<Record<string, unknown>>, options?: { fallback?: React.ReactNode }): React.ReactNode
}
export interface SidebarRootInjected { startSession(workspaceId?: string): void; toggleSidebar(): void }
export interface SidebarRootComponentProps extends SidebarRootInjected, PropsLocale<'sidebar'>, PropsRenderSlots<string> { collapsed: boolean; width: number }
export interface SidebarBrandNameOwnerProps { children?: never }
export interface SidebarSectionOwnerProps { wide: boolean; expandSidebar(): void }
export interface SidebarSettingsOwnerProps { wide: boolean }
export interface SidebarFooterActionOwnerProps { wide: boolean }
export function classNames(...values: readonly (string | false | null | undefined)[]): string { return values.filter(Boolean).join(' ') }
/** Exact legacy style identity, but editable source rather than compiled input. */
export function installStyles(id: string, plugin: string, css: string): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = plugin
  tag.dataset.pluginCss = id
  tag.textContent = css
  document.head.appendChild(tag)
}
