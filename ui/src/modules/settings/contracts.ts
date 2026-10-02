export type {SnapshotStore} from '../client-runtime/contract/store'
/** Type-only reuse of the connection's actual schema-decoded direct API. */
export type {SettingsNamespaceView, SettingsPathOpView} from '../client-connection/api'
export type IApiClient = Pick<import('../client-connection/api').IApiClient, 'settings'>
export interface ConnectionHandle {isLoopback: boolean; api: IApiClient}
export interface SettingsScopeSnapshot<Value> {status: 'loading' | 'ready' | 'unavailable'; value: Value | undefined; base: unknown; user: unknown; revision: number | undefined; writable: boolean; mode: 'host' | 'memory'}
export interface SettingsScopeSpec<Value> {namespace: string; decode?: (section: unknown) => Value | undefined}
export interface SettingsScope<Value> {
  getSnapshot(): SettingsScopeSnapshot<Value>; subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>; unset(field: string): Promise<void>
}
export interface SettingsContext {
  effect(effect: () => void | (() => void | Promise<void>), label: string): () => void
  on(name: 'connection/reset', listener: () => void): () => void
  remote: { $on(name: 'settings/document-updated', listener: () => void): () => void }
  get(name: 'connection'): ConnectionHandle
  get(name: 'remote'): SettingsContext['remote']
}
