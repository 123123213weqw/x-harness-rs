
import {decodeChatStoreState} from './contract/chat-store-codec'
import { defineStore } from "./runtime-values"
import type { EngineStoreHandle } from "./types/runtime"

import type { CallId, ChatStoreState, SelectionTarget } from './contract/views'

/** Declared action shape used to give the exported factory a stable return type. */
type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setDraft: (draft: ChatStoreState, text: string) => void
  setView: (draft: ChatStoreState, view: string) => void
  setInspect: (draft: ChatStoreState, target: { callId: CallId } | null) => void
}

/**
 * Declares the per-session chat state and write surface.
 * @returns the store handle.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    // Anchored to the contract shape: consumers read the store through
    // PropsStore<ChatStore>'s SnapshotSelectorHook<ChatStoreState>, so init
    // and the contract cannot drift.
    init: (): ChatStoreState => ({ selection: null, draft: '', view: null, inspect: null }),
    persist: 'dsh.conversation.chat',
    decode: decodeChatStoreState,
    bake: (bind, actions) => ({select: bind(actions.select), setDraft: bind(actions.setDraft), setView: bind(actions.setView), setInspect: bind(actions.setInspect)}),
    actions: {
      select: (d, target: SelectionTarget | null) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      setInspect: (d, target: { callId: CallId } | null) => { d.inspect = target },
    },
  })
}
