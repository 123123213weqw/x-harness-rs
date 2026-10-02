import type { EffectContext, LocaleService, SlotsService } from '../shared/runtime-types'
import type { ApiResult } from '../views-types'
/** Consumed settings service faces, independent of its implementation classes. */
export interface SnapshotStore<T> { getSnapshot(): T; subscribe(listener: () => void): () => void; set(value: T): void; update(edit: (draft: T) => void): void }
export interface SettingsNamespaceView { ns: string; value: unknown; base: unknown; user: unknown; revision: number; schema: unknown }
export type SettingsPathOpView = { op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] }
export interface SettingsScopeSpec<T> { namespace: string; decode?: (section: unknown) => T | undefined }
export interface SettingsScope<T> {
  getSnapshot(): { status: 'loading' | 'ready' | 'unavailable'; value: T | undefined; base: unknown; user: unknown; revision: number | undefined; writable: boolean; mode: 'host' | 'memory' }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}
export interface SettingsDescribeFace {
  getSnapshot(): { status: 'idle' | 'loading' | 'ready' | 'unavailable'; view: { namespaces: readonly SettingsNamespaceView[]; writable: boolean; hasDocument: boolean } | undefined; error: string | null }
  subscribe(listener: () => void): () => void
  ensure(): Promise<void>
  acceptView(view: SettingsNamespaceView): void
}
export interface SettingsSchemaNode { readonly type?: string; readonly meta: { readonly default?: unknown }; readonly list?: readonly { readonly value?: unknown }[] }
export interface SettingsSchemaService {
  rehydrate(serialized: unknown): SettingsSchemaNode
  validate(schema: SettingsSchemaNode, draft: unknown): string | undefined
  nodeAtPath(root: SettingsSchemaNode, path: readonly string[]): SettingsSchemaNode | undefined
  getPath(value: unknown, path: readonly string[]): unknown
  hasPath(value: unknown, path: readonly string[]): boolean
  setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown>
  deletePath(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown>
}

export interface ConfigurableProviderView {
  provider: string; displayName: string; settingsNs: string; settingsPath: readonly string[]; active: boolean; declared?: boolean
}
export interface CredentialView { configured: boolean; writable: boolean }
export interface DiscoveredModelView { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: unknown; imageInput?: boolean }
export interface IApiClient {
  settings: {
    mutate(params: { ns: string; ops: readonly SettingsPathOpView[]; expectedRevision?: number }): Promise<{ result: ApiResult<SettingsNamespaceView> }>
  }
  credentials: {
    describe(params: { refs: readonly string[] }): Promise<{ result: ApiResult<{ credentials: Readonly<Record<string, CredentialView | undefined>> }> }>
    set(params: { ref: string; value: string }): Promise<{ result: ApiResult<unknown> }>
    unset(params: { ref: string }): Promise<{ result: ApiResult<unknown> }>
  }
  llm: {
    providers(params: Record<string, never>): Promise<{ result: ApiResult<{ providers: readonly ConfigurableProviderView[] }> }>
    discoverModels(params: { settingsNs: string; provider?: string; baseURL?: string; api?: string; apiKey?: string }): Promise<{ result: ApiResult<{ models: readonly DiscoveredModelView[] }> }>
  }
}
type SnapshotValue<S> = S extends { getSnapshot(): infer V } ? V : never
export type InjectFace<I extends { hooks: object }> = Omit<I, 'hooks'> & {
  [K in keyof I['hooks'] as K extends string ? `use${Capitalize<K>}` : never]: <T>(select: (value: SnapshotValue<I['hooks'][K]>) => T) => T
}
export interface ModelsClientContext extends EffectContext {
  slots: SlotsService; locale: LocaleService; settingsSchema: SettingsSchemaService
  get(name: 'connection'): { api: IApiClient }
  settingsScope: { describe(): SettingsDescribeFace; bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T> }
  remote: { $on(event: string, listener: () => void): () => void }
  on(event: string, listener: () => void): () => void
}
