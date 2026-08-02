/** React-free consumed slot-host contracts; runtime ownership stays unchanged. */
import type {ReactNode} from 'react'
export interface HostObservable<T> {getSnapshot(): T; subscribe(listener: () => void): () => void}
export type SnapshotSelectorHook<T> = <S>(selector: (state: T) => S, equal?: (a: S, b: S) => boolean) => S
export type MaybeSnapshotSelectorHook<T> = <S>(selector: (state: T) => S, equal?: (a: S, b: S) => boolean) => S | undefined
export type Translate = (key: string, params?: Record<string, unknown>) => string
export interface LocaleFace extends HostObservable<{revision: number}> {bind(ns: string): Translate}
export interface StoreInstanceLike extends HostObservable<unknown> {readonly actions: Record<string, (...params: never[]) => void>}
export interface SessionMaybeProvideInfo {
  sessionId: string | undefined; hooks: Record<string, HostObservable<unknown> | undefined>; props: Record<string, unknown>;
  projections?: {faceOf(key: string): HostObservable<unknown>} | undefined
}
export interface SessionProvideInfo extends SessionMaybeProvideInfo {sessionId: string; hooks: Record<string, HostObservable<unknown>>}
export type SlotScope = 'root' | 'session-maybe' | 'session'
export interface SlotSpec {kind: 'single' | 'list' | 'keyed' | 'chain'; scope: SlotScope; inject?: object | undefined}
export interface StoredEntry {
  component: unknown; options: {key?: string; id?: string; order?: number; label?: string | (() => string); priority?: number};
  select?: ((owner: never) => unknown) | undefined; inject?: ((...args: never[]) => Record<string, unknown>) | undefined;
  children?: Readonly<Record<string, SlotSpec>> | undefined; store?: unknown; locale?: string | undefined; registrant?: string | undefined
}
export interface RenderOpts {entryKey?: string; only?: string; fallback?: ReactNode; hookContext?: unknown}
export interface ChainRenderOpts extends RenderOpts {overlay?: boolean}
export interface SlotRendererHost {
  subscribe(key: string, listener: () => void): () => void; getVersion(key: string): number;
  entriesOf(key: string): readonly StoredEntry[]; entriesOfSlot(key: string): readonly StoredEntry[];
  reportEntryError(key: string, entry: StoredEntry, error: unknown, info: {abdicate: boolean}): void;
  specOf(key: string): SlotSpec | undefined; isLive(entry: StoredEntry): boolean;
  storeOf(entry: StoredEntry, scope: string | undefined): StoreInstanceLike | undefined;
  sessions: {list: HostObservable<unknown>; provideInfo: HostObservable<SessionMaybeProvideInfo>};
  workspaces: {list: HostObservable<unknown>}; locale?: LocaleFace | undefined
}
export interface SlotRenderer {renderRoot(host: SlotRendererHost, owner: object): ReactNode}
export interface Context {
  slots: {install(renderer: SlotRenderer): void; renderSlot(name: 'root', owner: object): ReactNode};
  reflect: {provide(name: 'uiRenderer', value: {mount(container: HTMLElement, onReady?: () => void): () => void}): unknown};
  get(name: 'sessions'): {list: HostObservable<{current: string | undefined; byId: Readonly<Record<string, {title?: string} | undefined>>}>} | undefined
}
