/** Module-owned Cordis UI faces; protocol and runner types are source-owned peers. */
import type * as React from 'react'
import type {CordisRunnerFace} from '../cordis-client-runner/index'
import type {CordisDynamicPluginId, SessionId, DynamicCordisInventoryRow, DynamicCordisStopResponse, DynamicCordisUndefineReceipt} from '../cordis-client-runner/wire'
import type {Translation} from '../shared/runtime-types'
import type {CordisToolViewOwnerProps} from './slots'
export type {SessionId}
export type {CordisRunActivity, CordisRunFailure, CordisUserRunRequest} from '../cordis-client-runner/orchestrator'
export type {DynamicCordisLivePackage, DynamicCordisRenderFailure} from '../cordis-client-runner/runtime'
export interface HostObservable<T> {getSnapshot(): T; subscribe(listener: () => void): () => void}
export type InjectFace<Face> = Face extends {hooks: infer Hooks} ? Omit<Face, 'hooks'> & {
 [Key in keyof Hooks as Key extends string ? `use${Capitalize<Key>}` : never]: Hooks[Key] extends HostObservable<infer State> ? <T>(select: (state: State) => T) => T : never
} : Face
export type PropsLocale<_NS extends string> = {t: Translation}
export type PropsRuntime<_Seat extends string> = {wide: boolean; useSessions<T>(select: (state: {current: string | undefined}) => T): T}
export type PropsRenderSlots<Key extends string> = {renderSlot(key: Key, owner: CordisToolViewOwnerProps, opts: {entryKey: string; fallback: React.ReactNode}): React.ReactNode}
export interface ActiveToolBlock {callId: string; argsRaw: string}
export interface SettledToolBlock {kind: 'tool-result'; callId: string; seq: number; call?: {argsRaw?: string}; isError?: boolean; meta?: unknown; error?: {name: string; code: string}; content: readonly ({type: 'text'; text: string} | {type: 'image'; [key: string]: unknown})[]}
export interface ToolCallViewProps {callId: string; toolName: string; block: ActiveToolBlock | SettledToolBlock; inspect?: (() => void) | undefined}
export interface InputTriggerSource {
 trigger: string; name: string; order: number;
 candidates(session: {sessionId: string}, query: {query: string; signal?: AbortSignal}): Promise<readonly {name: string; description?: string}[]>
 warm(): void; lexicon(session: {sessionId: string}): readonly string[]; subscribeLexicon(session: {sessionId: string}, listener: () => void): () => void
 onPick(input: {candidate: {name: string}}): {text: string}
}
export interface InputTriggerService {registerSource(source: InputTriggerSource): () => void}
type RemoteResult<T> = {ok: true; value: T} | {ok: false; error: {code: string; message: string}}
export interface ClientContext {
 dynamicCordisRunner: CordisRunnerFace
 effect(effect: () => void | (() => void), label: string): unknown
 locale: {register(ns: string, dictionaries: {zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>>}): () => void}
 get(name: 'inputTriggers'): InputTriggerService
 on(name: 'connection/reset', listener: () => void): () => void
 remote: {
  $on(name: 'cordis/request-run', listener: (request: {pluginId: CordisDynamicPluginId}) => void): () => void
  $on(name: 'cordis/dynamic-package' | 'cordis/dynamic-retract' | 'cordis/request-run-resolved', listener: () => void): () => void
  dynamicCordisRunner: {stopFromPanel(session: string, plugin: CordisDynamicPluginId): Promise<RemoteResult<DynamicCordisStopResponse>>; undefineFromPanel(session: string, plugin: CordisDynamicPluginId): Promise<RemoteResult<DynamicCordisUndefineReceipt>>; inventory(): Promise<RemoteResult<readonly DynamicCordisInventoryRow[]>>}
 }
 slots: {inject(name: string, effect: () => unknown): unknown; register<P>(spec: {name: string; id?: string; key?: string; locale: string; inject?: (...args: never[]) => unknown; children?: Readonly<Record<string, {kind: 'keyed'; scope: 'session'}>>}, component: React.ComponentType<P>): () => void}
}
