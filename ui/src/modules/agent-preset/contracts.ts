/** Agent-preset wire and slot faces, owned here rather than importing a legacy package. */
import type * as React from 'react'
import type { SnapshotStore, SettingsNamespaceView } from '../settings/contracts'
import type { SettingsDescribeFace } from '../settings/settings-mirror'
import type { RosterValue } from './settings-store'
import type { Translation } from '../shared/runtime-types'
export type {SnapshotStore, SettingsDescribeFace}
type Response<T> = Promise<{result: {ok: true; value: T} | {ok: false; error: {code: string; message: string}}}>
export interface IApiClient {
  settings: {update(input: {ns: string; patch: {default: string}}): Response<SettingsNamespaceView>}
  agentPresets: {
    list(input: Record<string, never>): Response<RosterValue>
    select(input: {sessionId: string; agentPreset: string}): Response<{agentPreset: string}>
    read(input: {agentPreset: string}): Response<{name?: string; content: string}>
    copy(input: {from: string; agentPreset: string; name?: string}): Response<unknown>
    openDocument(input: {agentPreset: string}): Response<{opened: boolean; path: string}>
    remove(input: {agentPreset: string}): Response<unknown>
  }
}
export interface ConnectionHandle {api: IApiClient}
export type InjectFace<Face> = Face extends {hooks: infer Hooks} ? Omit<Face, 'hooks'> & {
  [Key in keyof Hooks as Key extends string ? `use${Capitalize<Key>}` : never]: Hooks[Key] extends SnapshotStore<infer State> ? <T>(select: (state: State) => T) => T : never
} : Face
export interface PropsLocale<_NS extends string> {t: Translation}
export interface SessionSummary {id: string; blank: boolean; agentPreset?: string}
export interface PropsRuntime<_Seat extends string> {close(): void; sessionId: string; locked: boolean; useSessions<T>(select: (state: {byId: Readonly<Record<string, SessionSummary | undefined>>}) => T): T}
export interface ClientContext {
  get(name: 'connection'): ConnectionHandle
  settingsScope: {describe(): SettingsDescribeFace}
  effect(effect: () => void | (() => void), label: string): unknown
  locale: {register(ns: string, dictionaries: {zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>>}): () => void; bind(ns: string): Translation}
  remote: {
    $on(name: 'settings/document-updated', listener: (ns: string) => void): () => void
    $on(name: 'agent-preset/selected', listener: (sessionId: string, agentPreset: string) => void): () => void
  }
  on(name: 'connection/reset', listener: () => void): () => void
  inject(names: string[], callback: (scope: ClientContext) => void): unknown
  sessions: {list: {getSnapshot(): {current: string | undefined; byId: Readonly<Record<string, SessionSummary | undefined>>}; subscribe(listener: () => void): () => void}; noteAgentPreset(id: string, preset: string): void}
  workspaces: {startSession(): void}
  slots: {inject(name: string, effect: () => unknown): void; register<P>(spec: {name: string; id?: string; order?: number; label?: () => string; locale: string; inject(): unknown}, component: React.ComponentType<P>): () => void}
}
