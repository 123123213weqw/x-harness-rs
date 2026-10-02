import type * as React from 'react'
import type {ApiResult, SlotsService, Translation} from '../views-types'
import type {SettingsDescribeFace} from '../settings/settings-mirror'
import type {SettingsScope, SettingsScopeSpec} from '../settings/contracts'
export interface Observable<Value> {getSnapshot(): Value; subscribe(listener: () => void): () => void}
export type Selector<Value> = <Selected>(select: (state: Value) => Selected) => Selected
export interface RenderSlots {renderSlot(name: string, owner: Readonly<Record<string,unknown>>, options?: {only?: string; entryKey?: string; fallback?: React.ReactNode}): React.ReactNode}
export interface StoredEntry {options: {id?: string; key?: string; order?: number; label?: string | (() => string)}}
export interface PluginSlots extends SlotsService {
  getVersion(name: string): number; entries(name: string): readonly StoredEntry[]
  subscribe(name: string, listener: () => void): () => void
}
export interface CredentialsApi {credentials: {
  describe(input: {refs: readonly string[]}): Promise<{result: ApiResult<{credentials: Readonly<Record<string,{configured: boolean; writable: boolean} | undefined>>}>}>
  set(input: {ref: string; value: string}): Promise<{result: ApiResult<unknown>}>
}}
export interface PluginsContext {
  effect(effect: () => void | (() => void), label: string): () => void
  get(name: 'connection'): {api: CredentialsApi}
  slots: PluginSlots
  locale: {register(namespace: string, values: {zh: Readonly<Record<string,string>>; en: Readonly<Record<string,string>>}): () => void; bind(namespace: string): Translation; getSnapshot(): {revision: number}; subscribe(listener: () => void): () => void}
  remote: {$on(name: 'credentials/updated', listener: (ref: string) => void): () => void}
  settingsScope: {describe(): SettingsDescribeFace; bind<Value>(spec: SettingsScopeSpec<Value>): SettingsScope<Value>}
}
