/** Internal React bindings for the renderer host and active session provide bundle. */
import { createContext, useContext, type ReactNode } from 'react'
import type {
  HostObservable, MaybeSnapshotSelectorHook, SessionMaybeProvideInfo, SessionProvideInfo,
  SlotRendererHost, SnapshotSelectorHook,
} from './contracts'
import { bindSnapshotSelector } from './bind'
import {isObjectRecord} from '../shared/runtime-types'

/** The renderer deliberately observes unknown snapshots; the providing domain
 * owns their payload schema. This guard checks only the observable ABI. */
export function isHostObservable(value: unknown): value is HostObservable<unknown> {
  return isObjectRecord(value) && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function'
}
function isSessionMaybeProvideInfo(value: unknown): value is SessionMaybeProvideInfo {
  if (!isObjectRecord(value) || (value.sessionId !== undefined && typeof value.sessionId !== 'string')) return false
  if (!isObjectRecord(value.hooks) || !isObjectRecord(value.props)) return false
  if (!Object.values(value.hooks).every(source => source === undefined || isHostObservable(source))) return false
  return value.projections === undefined || (isObjectRecord(value.projections) && typeof value.projections.faceOf === 'function')
}
/** A selected-session bundle has only present, observable hook sources. */
export function isSessionProvideInfo(value: SessionMaybeProvideInfo): value is SessionProvideInfo {
  return value.sessionId !== undefined && Object.values(value.hooks).every(isHostObservable)
}

/**
 * A missing-provider assembly error: the shell wired the tree wrong. The slot
 * error boundary rethrows this class so misassembly stays fail-loud while
 * registrant errors (inject factories, entry components) are contained
 * per entry.
 */
export class SlotAssemblyError extends Error {}

/** In-package renderer host context. */
export const HostContext = createContext<SlotRendererHost | null>(null)

/**
 * Read the installed renderer host; throws outside the rendered root tree
 * (framework components must not render detached from the renderer).
 * @returns the host API.
 */
export function useHost(): SlotRendererHost {
  const host = useContext(HostContext)
  if (!host) throw new SlotAssemblyError('slot machinery rendered outside the installed renderer tree')
  return host
}

const BindingContext = createContext<SessionMaybeProvideInfo | null>(null)

/** Read the current-session-optional bundle supplied at the root. */
export function useSessionMaybeProvideInfo(): SessionMaybeProvideInfo {
  const info = useContext(BindingContext)
  if (!info) throw new SlotAssemblyError('session-aware slot rendered outside the root binding provider')
  return info
}

/**
 * Read the enclosing session provide bundle; throws outside a SessionProvider
 * subtree (session slots must not render without a session).
 * @returns the enclosing bundle.
 */
export function useSessionProvideInfo(): SessionProvideInfo {
  const info = useSessionMaybeProvideInfo()
  if (!isSessionProvideInfo(info)) throw new SlotAssemblyError('strict session slot rendered without a session')
  return info
}

/**
 * Identity-stable selector hook per host observable. uSES resubscribes when
 * the subscribe reference changes, so the bound hook must be created once per
 * source — cached here by source identity (sources are host-owned singletons).
 * @param source - host-provided observable.
 * @returns the cached selector hook.
 */
export function observableHook(source: HostObservable<unknown>): SnapshotSelectorHook<unknown> {
  let hook = hookCache.get(source)
  if (hook === undefined) {
    hook = bindSnapshotSelector(source)
    hookCache.set(source, hook)
  }
  return hook
}
const hookCache = new WeakMap<object, SnapshotSelectorHook<unknown>>()

const absentSource: HostObservable<undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}

/** Bind a source that disappears with the current session to an optional selector hook. */
export function maybeObservableHook(source: HostObservable<unknown> | undefined): MaybeSnapshotSelectorHook<unknown> {
  if (source !== undefined) return observableHook(source)
  return useAbsentSnapshot
}

function useAbsentSnapshot<S>(_selector: (snapshot: never) => S, _equal?: (a: S, b: S) => boolean): S | undefined {
  // The uSES subscription must still run (hook-order stability); the absent
  // source always snapshots undefined, returned explicitly.
  observableHook(absentSource)(() => undefined)
  return undefined
}

/**
 * The useProjection framework seat (docs/subsystems/session-projection.md), one bound
 * function per provide bundle (cached by info identity — components may hold
 * it across renders). Key-addressed: the key resolves a per-session value
 * face off the projection store; the bound selector hook comes from the same
 * per-source cache as every other kit hook, so exactly one uSES subscription
 * runs per call and the subscribe reference stays stable per key. A key no
 * baseline or frame has carried (or a no-session bundle) reads `undefined` —
 * capability absence — keeping the hook order constant.
 */
export function projectionHook(info: SessionMaybeProvideInfo): (
  key: string, selector?: (value: unknown) => unknown, eq?: (a: unknown, b: unknown) => boolean,
) => unknown {
  let hook = projectionHookCache.get(info)
  if (hook === undefined) {
    hook = (key, selector, eq) => {
      // The no-session (faceless) branch binds the shared absent source so
      // the caller's selector still runs over `undefined` (absence flows
      // through the selector) and the uSES call count stays constant.
      const useValue = observableHook(info.projections?.faceOf(key) ?? absentSource)
      // Whole values are finished wire payloads (reference changes only when
      // a frame or baseline lands), so the identity selector needs no
      // equality function.
      return useValue(selector ?? (value => value), eq)
    }
    projectionHookCache.set(info, hook)
  }
  return hook
}
const projectionHookCache = new WeakMap<SessionMaybeProvideInfo, (
  key: string, selector?: (value: unknown) => unknown, eq?: (a: unknown, b: unknown) => boolean,
) => unknown>()

/**
 * Root-level binding provider. It follows current selection without a key;
 * per-entry identity is the outlet's adoption bookkeeping (SessionMaybeEntry):
 * a blank-born incarnation adopts the first session without remounting, and
 * every later transition (switch or loss) remounts like a strict entry.
 */
export function SessionMaybeProvider({ children }: { children: ReactNode }) {
  const host = useHost()
  const info = observableHook(host.sessions.provideInfo)(value => {
    if (!isSessionMaybeProvideInfo(value)) throw new SlotAssemblyError('invalid session provide info')
    return value
  })
  return (
    <BindingContext.Provider value={info}>
      {children}
    </BindingContext.Provider>
  )
}

/** SessionProvider API: render-prop body plus the no-session branch. */
export interface SessionProviderProps {
  /** No-session body (also covers a current id whose session cannot be resolved). */
  empty?: (() => ReactNode) | undefined
  /** Session body; remounted per session via key={sessionId}. */
  children: (sessionId: string) => ReactNode
}

/**
 * Framework-wired session area: subscribes to the host's current provide
 * source and remounts the body under `key={sessionId}` so a session switch
 * rebuilds the session subtree. This dependency-inverted layer uses plain
 * string ids; `PropsRuntime` applies the branded type at the component
 * boundary.
 */
export function SessionProvider({ empty, children }: SessionProviderProps) {
  const host = useHost()
  const info = observableHook(host.sessions.provideInfo)(value => {
    if (!isSessionMaybeProvideInfo(value)) throw new SlotAssemblyError('invalid session provide info')
    return value
  })
  const id = info.sessionId
  if (id === undefined) return <>{empty?.() ?? null}</>
  return (
    <BindingContext.Provider value={info} key={id}>
      {children(id)}
    </BindingContext.Provider>
  )
}
