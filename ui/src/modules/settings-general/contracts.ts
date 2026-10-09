import type * as React from 'react'
import type {ApiResult, SlotsService, Translation} from '../views-types'
import type {SettingsDescribeFace} from '../settings/settings-mirror'
export interface Observable<Value> {getSnapshot(): Value; subscribe(listener: () => void): () => void}
export type Selector<Value> = <Selected>(select: (state: Value) => Selected) => Selected
export interface RenderSlots {renderSlot(name: string, owner: Readonly<Record<string, unknown>>, options?: {only?: string; fallback?: React.ReactNode}): React.ReactNode}
export interface GeneralApi {settings: {openDocument(input: Record<string,never>): Promise<{result: ApiResult<unknown>}>}}
export interface GeneralConnection {isLoopback: boolean; api: GeneralApi}
export interface GeneralSlots extends SlotsService {
  getVersion(name: string): number
  entries(name: string): readonly {options: {id?: string; order?: number; label?: string | (() => string)}}[]
  subscribe(name: string, listener: () => void): () => void
}
export interface GeneralContext {
  on(event: 'settings/open-section', listener: (section: string) => void): () => void
  effect(effect: () => void | (() => void), label: string): () => void
  get(name: 'connection'): GeneralConnection
  slots: GeneralSlots
  locale: {register(namespace: string, values: {zh: Readonly<Record<string,string>>; en: Readonly<Record<string,string>>}): () => void; bind(namespace: string): Translation; getSnapshot(): {revision: number}; subscribe(listener: () => void): () => void}
  settingsScope: {describe(): SettingsDescribeFace}
}
