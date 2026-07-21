import * as React from 'react'

export type TranscriptValues = Map<string, unknown>
type BooleanSeat = [boolean, React.Dispatch<React.SetStateAction<boolean>>]
type ModeSeat = [string | null, React.Dispatch<React.SetStateAction<string | null>>]
export interface TranscriptStateBridge {
  Context: React.Context<TranscriptValues | null>
  useState(key: string, initial: boolean): BooleanSeat
  useState(key: string, initial: string | null): ModeSeat
}

declare global {
  var __xhTranscriptState: WeakMap<typeof React.createElement, TranscriptStateBridge> | undefined
}

function createBridge(): TranscriptStateBridge {
  const Context = React.createContext<TranscriptValues | null>(null)
  function useStoredState<T extends boolean | string | null>(key: string, initial: T, read: (value: unknown) => T | undefined): [T, React.Dispatch<React.SetStateAction<T>>] {
    const store = React.useContext(Context)
    const [value, publish] = React.useState<T>(() => {
      const restored = read(store?.get(key))
      if (restored !== undefined) return restored
      store?.set(key, initial)
      return initial
    })
    const current = React.useRef(value)
    const set = React.useCallback<React.Dispatch<React.SetStateAction<T>>>(next => {
      const result = typeof next === 'function' ? next(current.current) : next
      current.current = result
      store?.set(key, result)
      publish(result)
    }, [store, key])
    return [value, set]
  }
  function useState(key: string, initial: boolean): BooleanSeat
  function useState(key: string, initial: string | null): ModeSeat
  function useState(key: string, initial: boolean | string | null): BooleanSeat | ModeSeat {
    if (typeof initial === 'boolean') return useStoredState(key, initial, value => typeof value === 'boolean' ? value : undefined)
    return useStoredState(key, initial, value => typeof value === 'string' || value === null ? value : undefined)
  }
  return { Context, useState }
}

/** Shared by independent plugin factories through the unchanged React singleton. */
export function transcriptStateFor(react: Pick<typeof React, 'createElement'>): TranscriptStateBridge {
  const registry = globalThis.__xhTranscriptState ??= new WeakMap()
  let state = registry.get(react.createElement)
  if (!state) {
    state = createBridge()
    registry.set(react.createElement, state)
  }
  return state
}

export const transcriptState = transcriptStateFor(React)
export const useTranscriptState = transcriptState.useState
