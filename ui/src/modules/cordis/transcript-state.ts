import * as React from 'react'
import type { TranscriptStateBridge } from '../conversation/chat/transcript-state'

/** Resolve the row-owned seat through the same React singleton as the transcript. */
export function useTranscriptState(key: string, initial: boolean): [boolean, React.Dispatch<React.SetStateAction<boolean>>]
export function useTranscriptState(key: string, initial: string | null): [string | null, React.Dispatch<React.SetStateAction<string | null>>]
export function useTranscriptState(key: string, initial: boolean | string | null):
  [boolean, React.Dispatch<React.SetStateAction<boolean>>] |
  [string | null, React.Dispatch<React.SetStateAction<string | null>>] {
  const bridge: TranscriptStateBridge | undefined = globalThis.__xhTranscriptState?.get(React.createElement)
  if (typeof initial === 'boolean') return bridge ? bridge.useState(key, initial) : React.useState(initial)
  return bridge ? bridge.useState(key, initial) : React.useState(initial)
}
