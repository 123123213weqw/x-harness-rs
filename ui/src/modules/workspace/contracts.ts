/** Consumed workspace/session data, store and Cordis service contracts. */
import type * as React from 'react'
import type {DirectoryFlowOwnerProps} from './contract/slots'
import type {Translation} from '../shared/runtime-types'
export type SessionId = string
export type WorkspaceId = string
export type PendingInteractionStatus = 'approval' | 'plan-review' | 'question'
export interface SessionSummary {id: SessionId; title?: string; displayTitle: string; cwd?: string; parentId?: string; origin?: 'subagent'; running: boolean; pendingInteraction?: PendingInteractionStatus; completed?: boolean; blank: boolean; updatedAt: number}
export interface SubagentDescendantSummary {count: number; runningCount: number}
export interface SessionSearchResultItem {sessionId: string; snippet: string}
export interface SessionListState {ids: string[]; byId: Record<string, SessionSummary>; current: string | undefined; phase: 'pending' | 'ready'}
export interface WorkspaceView {workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string}
export interface WorkspaceListState {items: readonly WorkspaceView[]; archivedSessionIds: readonly string[]; state: 'idle' | 'loading' | 'error'; phase: 'pending' | 'ready'; baselinesReady: boolean; recentWorkspaceId: string | undefined; error: {message: string} | null}
export interface HostObservable<T> {getSnapshot(): T; subscribe(listener: () => void): () => void}
export type SnapshotSelectorHook<T> = <S>(select: (value: T) => S, equal?: (a: S, b: S) => boolean) => S
export interface HostDescription {home?: string}
export type HostDescriptionSource = HostObservable<HostDescription | undefined>
export interface ConnectionHandle {hostDescription: HostDescriptionSource}
export type PropsHooks<Hooks> = {[Key in keyof Hooks as Key extends string ? `use${Capitalize<Key>}` : never]: Hooks[Key] extends HostObservable<infer State> ? SnapshotSelectorHook<State> : never}
export type PropsLocale<_NS extends string> = {t: Translation}
export interface EngineStoreHandle<T, A> {readonly spec: {init(): T; actions: A; persist?: string}}
export type PropsStore<Handle> = Handle extends EngineStoreHandle<infer T, infer A> ? {useStore: SnapshotSelectorHook<T>; actions: {[K in keyof A]: A[K] extends (draft: T, ...args: infer Args) => void ? (...args: Args) => void : never}} : never
export type PropsRuntime<Seat extends string> = {useWorkspaces: SnapshotSelectorHook<WorkspaceListState>; useSessions: SnapshotSelectorHook<SessionListState>} & (Seat extends 'sidebar.workspaces' ? {wide: boolean; expandSidebar(): void} : {open: boolean; anchorRef?: React.RefObject<HTMLElement | null> | undefined; selectedId?: WorkspaceId | undefined; onPick(id: WorkspaceId): void; onClose(): void})
export type PropsRenderSlots<Key extends string> = {renderSlot(key: Key, owner: DirectoryFlowOwnerProps): React.ReactNode}
type Result<T> = {ok: true; value: T} | {ok: false; error: {message: string}}
export interface ClientContext {
  get(name: 'connection'): ConnectionHandle
  effect(effect: () => void | (() => void), label: string): unknown
  locale: {register(ns: string, dictionaries: {zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>>}): () => void}
  sessions: {search(query: string, signal: AbortSignal): Promise<Result<{items: readonly SessionSearchResultItem[]; hasMore: boolean}>>; searchResultLimit: number; open(id: string): void; binding(id: string): {session: {rename(title: string): Promise<Result<unknown>>}} | undefined; fork(input: {sessionId: string; increaseTitle: boolean}): Promise<string>}
  workspaces: {startSession(id?: string): void; rename(id: string, title: string): Promise<unknown>; delete(id: string): Promise<unknown>; insertBefore(id: string, before?: string): Promise<unknown>; archiveSession(id: string): Promise<unknown>; insertSessionBefore(workspaceId: string, id: string, before?: string): Promise<unknown>; create(input: {path: string}): Promise<WorkspaceView>}
  slots: {entries(key: string): readonly unknown[]; subscribe(key: string, listener: () => void): () => void; inject(name: string, effect: () => unknown): void; register<P>(spec: {name: string; children: Readonly<Record<string, {kind: 'single'; scope: 'root'}>>; store?: EngineStoreHandle<unknown, object>; inject(): unknown; locale: string}, component: React.ComponentType<P>): () => void}
}
