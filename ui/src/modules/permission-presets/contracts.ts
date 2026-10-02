/** Module-owned consumed contracts. The Host remains the projection/settings authority. */
import type * as React from 'react'
import type { SnapshotStore, IApiClient, SettingsNamespaceView } from '../settings/contracts'
import type { SettingsDescribeFace } from '../settings/settings-mirror'
import type { SettingsSchemaService, SchemaNode } from '../settings/schema'
import type { Translation } from '../shared/runtime-types'
export type {SnapshotStore, IApiClient, SettingsNamespaceView, SettingsDescribeFace, SettingsSchemaService, SchemaNode}
export interface PermissionSelect {currentValue: string; options: readonly {value: string; name: string; description?: string}[]}
export interface SessionFace {projections: {faceOf(name: 'permissions'): {getSnapshot(): PermissionSelect | undefined}}; command(line: string): Promise<{ok: true; value: {matched: boolean}} | {ok: false; error: {code: string; message: string}}>}
export interface ClientSessionContext {sessionId: string}
export interface SelectOption {id: string; label: string; detail?: string; active?: boolean; confirmation?: {title: string; description: string; acknowledgeLabel: string; cancelLabel: string; confirmLabel: string}}
export interface CommandUiContract {decorate(spec: {name: string; available(session: ClientSessionContext): boolean; ui: {kind: 'popupSelect'; options(session: ClientSessionContext): Promise<SelectOption[]>; onSelect(option: SelectOption, session: ClientSessionContext): Promise<void>}}): () => void}
export interface ConnectionHandle {api: IApiClient}
export interface ClientContext {
  get(name: 'commandUi'): CommandUiContract
  get(name: 'connection'): ConnectionHandle
  sessions: {binding(id: string): {session: SessionFace} | undefined}
  effect(effect: () => void | (() => void), label: string): unknown
  locale: {
    register(ns: string, dictionaries: {zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>>}): () => void
    register(ns: string, language: 'zh' | 'en', dictionaries: Readonly<Record<string, string>>): () => void
    bind(ns: string): Translation
  }
  settingsScope: {describe(): SettingsDescribeFace}
  settingsSchema: SettingsSchemaService
  slots: {inject(name: string, effect: () => unknown): unknown; register<P>(spec: {name: string; id: string; order: number; locale: string; inject(): unknown}, component: React.ComponentType<P>): () => void}
}
