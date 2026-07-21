/**
 * Snapshot store engine (zustand vanilla + immer + subscribeWithSelector +
 * rafFlush middleware + opt-in persist + dev freeze) plus the declarative
 * shell over it: {@link defineStore} bakes an init/persist/actions literal
 * into a {@link StoreHandle}, the registration-side store seat of slot
 * terminals. Lives in the React-free runtime (the data layer owns its
 * engine; ui-renderer is shell-only React
 * glue): engine products are bare observables — subscribe/getSnapshot/
 * update/set, NO selector hook. Hook synthesis is ui-renderer's (the one
 * uSES bridge, cached per source at the binding site).
 */
import { createStateEngine, shallow, type StoreApi } from './state-engine'
import { produce, type Draft } from 'immer'
import {isRecord} from '../value-guards'
import type {
  ActionsDecl, ActionBinder, BakedActions, StoreHandle, StoreInstance, StoreSpec,
} from '@xharness/dsh-client-ui-slots'

// Store contract types are ui-slots authority; re-exported beside the engine
// so store consumers get one import path.
export type {
  ActionsDecl, BakedActions, BoundActions, StoreFactory, StoreHandle, StoreInstance, StoreSpec,
} from '@xharness/dsh-client-ui-slots'

/** Minimal observable snapshot source: Session objects and snapshot stores both satisfy it. */
export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }

/** Writable snapshot store (bare data face; React selector hooks are synthesized in ui-renderer). */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  /**
   * Mutate the state through an immer draft.
   * @param mutator - draft mutator.
   */
  update(mutator: (draft: Draft<T>) => void): void
  /**
   * Replace the state wholesale.
   * @param next - next state.
   */
  set(next: T): void
}

/**
 * Shallow equality for selector slices (zustand/shallow semantics; travels
 * with the engine so hook consumers need no zustand dependency).
 * @param a - left value.
 * @param b - right value.
 * @returns whether the values are shallowly equal.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  return shallow(a, b)
}

/** Batches subscriber notification into one flush per animation frame. */
function rafBatch(notify: () => void): () => void {
  // Fall back to microtask batching where rAF is absent (node unit tests);
  // both preserve the N-changes=1-notification contract within a tick.
  const schedule: (fn: () => void) => void =
    typeof requestAnimationFrame === 'function'
      ? (fn) => { requestAnimationFrame(() => { fn() }) }
      : (fn) => { queueMicrotask(fn) }
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    schedule(() => {
      scheduled = false
      notify()
    })
  }
}

/**
 * Create a snapshot store.
 *
 * Flush default is 'sync' (controlled inputs need same-tick echo); frame-driven
 * stores opt into 'raf', where a frame's worth of updates coalesces into one
 * notification. Known raf-mode tradeoff: a component mounting mid-frame reads
 * fresh state while existing subscribers hear it next flush — transient
 * frame-level skew, same nature as the object layer's microtask batching.
 *
 * @param init - initial state.
 * @param opts - flush mode and opt-in persistence (localStorage, keyed by name).
 * @returns the store.
 */
export function createSnapshotStore<T>(init: T, opts?: {flush?: 'raf' | 'sync'; persist?: undefined}): SnapshotStore<T>
export function createSnapshotStore<T>(init: T, opts: {flush?: 'raf' | 'sync'; persist: {name: string; decode(value: unknown): T}}): SnapshotStore<T>
export function createSnapshotStore(init: unknown, opts?: {flush?: 'raf' | 'sync'; persist?: {name: string; decode?: (value: unknown) => unknown} | undefined}): SnapshotStore<unknown>
export function createSnapshotStore(
  init: unknown, opts?: {flush?: 'raf' | 'sync'; persist?: {name: string; decode?: (value: unknown) => unknown} | undefined},
): unknown {
  // Immer enters through produce() in update() below (identical semantics to
  // the immer middleware without its setState-signature mutator generics).
  const api = createStateEngine<unknown>(init)
  if (opts?.persist) attachPersistence(api, opts.persist.name, opts.persist.decode)

  let subscribe = (fn: () => void) => api.subscribe(fn)
  if (opts?.flush === 'raf') {
    const listeners = new Set<() => void>()
    const flush = rafBatch(() => { for (const fn of [...listeners]) fn() })
    api.subscribe(flush)
    subscribe = (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
  }

  return {
    getSnapshot: () => api.getState(),
    subscribe: (fn: () => void) => subscribe(fn),
    update: (mutator: (draft: unknown) => void) => {
      // Immer's produce (not setState's partial-merge path) so scalar and
      // array roots replace correctly; produce also freezes in dev.
      api.setState(produce(api.getState(), (draft) => { mutator(draft) }), true)
    },
    set: (next: unknown) => {
      api.setState(devFreeze(next), true)
    },
  }
}

/**
 * Whole-value JSON persistence to localStorage. Hand-rolled instead of the
 * zustand persist middleware: its write path spreads state into an object
 * (`partialize({ ...get() })`), exploding primitive state (a persisted string
 * draft becomes {0:'h',1:'e',...}) — not fixable via merge/deserialize options
 * because the corruption happens before serialization. Storage failures
 * (quota, private mode) only disable persistence, never break the store.
 */
function attachPersistence(api: StoreApi<unknown>, name: string, decode?: (value: unknown) => unknown): void {
  // Non-browser runs (node e2e booting the client tree) have no localStorage:
  // persistence silently disables — same contract as a storage failure, minus
  // the per-store console noise a ReferenceError would produce.
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(name)
    if (raw !== null) {
      const value: unknown = JSON.parse(raw)
      api.setState(devFreeze(decode === undefined ? value : decode(value)), true)
    }
  } catch (error) {
    console.error(`snapshot store '${name}' rehydration failed:`, error)
  }
  api.subscribe((state) => {
    try {
      localStorage.setItem(name, JSON.stringify(state))
    } catch (error) {
      console.error(`snapshot store '${name}' persistence failed:`, error)
    }
  })
}

/** Deep-freeze wholesale-set state outside production: set() bypasses immer's freeze. */
function devFreeze<T>(value: T): T {
  // The frozen shipped module is a production build: wholesale set is not
  // auto-frozen. update still uses upstream Immer's default auto-freeze.
  return value
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) {
    const child: unknown = Reflect.get(value, key)
    deepFreeze(child)
  }
}

// ui-slots owns the contract; this module supplies the engine implementation.

/** A live engine instance: the contract instance plus the raw engine store. */
export interface EngineStoreInstance<T, A extends ActionsDecl<T>> extends StoreInstance<T, A> {
  /** The underlying engine store (framework/test API; components never see it). */
  readonly store: SnapshotStore<T>
}

/** The engine-backed handle: create() narrowed to the engine instance. */
export interface EngineStoreHandle<T, A extends ActionsDecl<T>> extends StoreHandle<T, A> {
  /**
   * Construct a live engine instance (see the contract JSDoc on
   * {@link StoreHandle.create} for scopeKey/persist semantics).
   *
   * Known boundary: the persist key is the storage identity, so multiple live
   * instances created under the same resolved key share (and cross-pollute)
   * one localStorage entry. Instance uniqueness per key is the caller's
   * responsibility — production is safe because the framework caches one
   * instance per handle x scope key; tests wanting isolation use distinct
   * scope keys or persist-free declarations (multi-create freedom is a
   * feature there, so create() deliberately does not dedupe or throw).
   * @param scopeKey - session id for session-scope instances; omitted for root scope.
   * @returns the engine instance.
   */
  create(scopeKey?: string): EngineStoreInstance<T, A>
}

/**
 * Declare a store: initial state, optional persistence, and the full write
 * set as pure draft mutators. The returned handle is the registration
 * currency of the store seat — its identity keys instance sharing. Satisfies
 * ui-slots' DefineStore contract (the handle/instance are the engine-extended
 * subtypes).
 *
 * The `A & ActionsDecl<T>` actions position is load-bearing: T resolves from
 * `init` in the first inference round, and the intersection then contextually
 * types each mutator's draft parameter (context-sensitive functions defer),
 * so call sites write `(d, x: X) => { ... }` with no draft annotation. If a
 * future TS version breaks this single-literal inference, the design's
 * documented fallback is currying (`defineStore(init).actions({...})`).
 * @param decl - init lambda (fresh state per instance), optional persist key, actions table.
 * @returns the store handle.
 */
/** Typed declarations prove both persistence and each concrete action tuple. */
export type TypedStoreSpec<T, A extends ActionsDecl<T>> = StoreSpec<T, A> & {
  actions: A & ActionsDecl<T>
  bake(bind: ActionBinder<T>, actions: A): BakedActions<T, A>
} & ({persist?: undefined} | {persist: string; decode(value: unknown): T})

/** Old JavaScript declarations retain their raw state without a false T promise. */
export interface RawStoreSpec {
  init(): unknown
  persist?: string
  decode?: (value: unknown) => unknown
  actions: Record<string, (...args: never[]) => unknown>
  bake?: (...args: never[]) => unknown
}
export interface RawEngineStoreHandle {
  readonly spec: RawStoreSpec
  create(scopeKey?: string): {
    readonly actions: Record<string, (...args: never[]) => void>
    getSnapshot(): unknown
    subscribe(listener: () => void): () => void
    readonly store: SnapshotStore<unknown>
    clearPersisted(): void
  }
}

export function defineStore<T, A extends ActionsDecl<T>>(decl: TypedStoreSpec<T, A>): EngineStoreHandle<T, A>
export function defineStore(decl: RawStoreSpec): RawEngineStoreHandle
export function defineStore(decl: RawStoreSpec): RawEngineStoreHandle {
  return {
    spec: decl,
    create(scopeKey?: string) {
      const persistKey = decl.persist === undefined ? undefined
        : scopeKey === undefined ? decl.persist : `${decl.persist}.${scopeKey}`
      const store = createSnapshotStore(decl.init(), persistKey === undefined ? undefined
        : {persist: {name: persistKey, ...(decl.decode === undefined ? {} : {decode: decl.decode})}})
      const bind = (mutate: unknown) => {
        if (typeof mutate !== 'function') throw new Error('store action must be a function')
        return (...params: unknown[]): void => {
          store.update(draft => { Reflect.apply(mutate, undefined, [draft, ...params]) })
        }
      }
      let actions: Record<string, (...args: never[]) => void>
      if (decl.bake !== undefined) {
        const baked: unknown = Reflect.apply(decl.bake, undefined, [bind, decl.actions])
        if (!isErasedActions(baked)) throw new Error('store bake must return callable actions')
        actions = baked
      } else {
        actions = {}
        for (const [key, mutate] of Object.entries(decl.actions)) actions[key] = bind(mutate)
      }
      return {
        actions,
        getSnapshot: () => store.getSnapshot(),
        subscribe: (fn: () => void) => store.subscribe(fn),
        store,
        clearPersisted: () => {
          if (persistKey === undefined || typeof localStorage === 'undefined') return
          try { localStorage.removeItem(persistKey) } catch { /* Same non-fatal storage ABI. */ }
        },
      }
    },
  }
}

/** Erasure claims no argument or result domain: concrete tuples come only from typed bake. */
function isErasedActions(value: unknown): value is Record<string, (...args: never[]) => void> {
  return isRecord(value) && Object.values(value).every(action => typeof action === 'function')
}
