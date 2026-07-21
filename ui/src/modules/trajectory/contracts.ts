/** Narrow module-owned UI hosts; event and conversation currencies are source-owned runtime types. */
import type * as React from 'react'
import type {ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode, ConversationSnapshot, SessionId} from '../client-runtime/index'
import type {Translation} from '../shared/runtime-types'
export type TranslateNS<_NS extends string> = Translation
export type PropsLocale<_NS extends string> = {t: Translation}
export type InjectFace<Face> = Face extends {hooks: infer Hooks} ? Omit<Face, 'hooks'> & {
 [Key in keyof Hooks as Key extends string ? `use${Capitalize<Key>}` : never]: Hooks[Key] extends {getSnapshot(): infer State; subscribe(listener: () => void): () => void} ? <T>(select: (state: State) => T) => T : never
} : Face
export interface ConvViewProps {
 useSession<T>(select: (snapshot: ConversationSnapshot) => T): T
 inspect?: {callId: string} | null
 onInspectDone?: () => void
}
export interface Context {
 effect(effect: () => void | (() => void), label: string): unknown
 locale: {register(ns: string, dictionaries: {zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>>}): () => void; bind(ns: string): Translation}
 conversationEvents: {register<State>(definition: ConversationNodeDefinition<State>): () => void}
 conversationViews: {register<Node extends ConversationViewNode, Snapshot>(definition: ConversationViewDefinition<Node, Snapshot>): () => void}
 sessions: {binding(sessionId: SessionId): {session: {getSnapshot(): ConversationSnapshot; loadOlder(): Promise<void>}} | undefined}
 slots: {inject(name: string, effect: () => unknown): unknown; register<P>(spec: {name: string; id: string; order: number; locale: string; label(): string; inject(sessionId: SessionId): unknown}, component: React.ComponentType<P>): () => void}
}
