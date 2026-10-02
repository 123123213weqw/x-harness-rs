import type { ObservableStore, EffectContext, LocaleService, SlotsService, Translation } from '../shared/runtime-types'
import type { ModelDirectory } from './directory'
import type { ModelDirectoryResolver } from './service'

/** Session wire contract. Capability vocabularies remain provider-owned. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
  contextWindowTokens?: number
}
export interface ModelReasoningEffort { id: string; name: string; description?: string }
export interface ModelReasoning { efforts: readonly ModelReasoningEffort[]; defaultEffort?: string }
export interface ModelCatalogEntry {
  id: string
  name: string
  description?: string
  contextWindow?: number
  contextWindowSource?: string
  contextWindowCapability?: unknown
  reasoningCapability?: { state?: string; stale?: boolean; source?: string }
  reasoning?: ModelReasoning
}
export interface ModelProviderGroup { id: string; name: string; models: readonly ModelCatalogEntry[] }
export interface ModelCatalogFailure { id: string; name: string; message: string }
export interface SessionModelsResponse {
  current: ModelSelection
  routable: boolean
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
}
export interface ModelDirectoryState {
  current: ModelSelection | null
  routable: boolean | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export interface SessionsWire {
  models(params: { sessionId: string; refreshCapabilities: boolean }): Promise<{ result: RemoteResult<SessionModelsResponse> }>
  selectModel(params: ModelSelection & { sessionId: string }): Promise<{ result: RemoteResult<{ selected: ModelSelection }> }>
}
export interface ModelSelectInjected {
  available: boolean
  directory: ObservableStore<ModelDirectoryState>
  load(refreshCapabilities?: boolean): void | Promise<unknown>
  select(selection: ModelSelection): Promise<boolean>
}
export type ModelSelectProps = ModelSelectInjected & { locked: boolean; t: Translation }
export interface ClientSessions {
  scope(sessionId: string): EffectContext | undefined
  subagentAddress(sessionId: string): unknown
}
export interface PopupOption { id: string; label: string; detail: string; active?: boolean }
export interface CommandUi {
  register(contribution: {
    name: string; description: string; available(session: { sessionId: string }): boolean
    ui: {
      kind: 'popupSelect'
      options(session: { sessionId: string }): Promise<PopupOption[]>
      onSelect(option: { id: string }, session: { sessionId: string }): Promise<void>
    }
  }): void | (() => void)
}
export interface ModelClientContext extends EffectContext {
  locale: LocaleService
  slots: SlotsService
  sessions: ClientSessions
  modelDirectories: ModelDirectoryResolver
  remote: { $on(event: string, listener: () => void): unknown }
  on(event: string, listener: () => void): unknown
  get(name: 'sessions'): ClientSessions
  get(name: 'connection'): { api: { sessions: SessionsWire } }
  get(name: 'conversation'): { blocks: { set(sessionId: string, block: { reason: string } | undefined): void } } | undefined
  get(name: 'commandUi'): CommandUi
  plugin(service: typeof ModelDirectoryResolver, config: { blockReason(): string }): unknown
  inject(names: string[], callback: (scope: ModelClientContext) => void): unknown
}
export interface DirectoryRequestOwner {
  disposed: boolean
  generation: number
  store: ModelDirectory['store']
}
export interface MutableModelStore<T> extends ObservableStore<T> { update(edit: (draft: T) => void): void }
