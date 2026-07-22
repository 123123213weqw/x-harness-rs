import {isRecord, isUnknownMap, isUnknownSet} from '../value-guards'
/** Strict adapter for the vanilla Zustand 4.4.7 ABI used by this runtime.
 * Whole-value replacement and live Set iteration are intentional. Selective
 * subscriptions are not exposed by SnapshotStore and are not synthesized here. */
export interface StoreApi<T> {
  getState(): T
  setState(next: T | ((current: T) => T), replace: true): void
  subscribe(listener: (state: T, previous: T) => void): () => void
}
export function createStateEngine<T>(initial: T): StoreApi<T> {
  let state = initial
  const listeners = new Set<(state: T, previous: T) => void>()
  return {
    getState: () => state,
    setState(next, _replace) {
      // Zustand evaluates a function-valued replacement as an updater, even
      // when replace=true; retaining that edge preserves the vanilla ABI.
      const replacement = isStateUpdater(next)
        ? next(state)
        : next
      if (Object.is(replacement, state)) return
      const previous = state
      state = replacement
      listeners.forEach(listener => listener(state, previous))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
/** Same shallow semantics as the consumed zustand/shallow 4.4.7 ABI.
 * Map values use Object.is, Set values use has(), enumerable object keys only. */
export function shallow(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (isUnknownMap(a) && isUnknownMap(b)) {
    if (a.size !== b.size) return false
    for (const [key, value] of a) if (!Object.is(value, b.get(key))) return false
    return true
  }
  if (isUnknownSet(a) && isUnknownSet(b)) {
    if (a.size !== b.size) return false
    for (const value of a) if (!b.has(value)) return false
    return true
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const left = a, right = b
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) return false
  return true
}

function isStateUpdater<T>(value: T | ((current: T) => T)): value is (current: T) => T {
  return typeof value === 'function'
}
