import type { SlotsService, Translation } from '../views-types'
import type { InputTriggerService } from './service'
import type { InputTriggerServiceContract } from './contract'
import type { BeginCommandRequest, InsertReferenceRequest, InsertTextRequest } from './types'
export interface SnapshotStore<Value> {
  getSnapshot(): Value
  subscribe(listener: () => void): () => void
  set(value: Value): void
}
export interface TriggerSessions {
  scope(id: string): TriggerContext | undefined
  scopeOf(context: TriggerContext): string | undefined
}
/** Only the service carrier and input mutation events this contributor uses. */
export interface TriggerContext {
  effect(effect: () => void | (() => void), label: string): void
  locale: {register(namespace: string, dictionaries: {zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>>}): () => void; bind(namespace: string): Translation}
  slots: SlotsService
  inputTriggers: InputTriggerServiceContract
  sessions: TriggerSessions
  get(name: 'sessions'): TriggerSessions | undefined
  plugin(service: typeof InputTriggerService): void
  inject(names: readonly string[], callback: (scope: TriggerContext) => void): void
  bail(subject: TriggerContext, name: 'slash/input-begin-command', request: BeginCommandRequest): true | undefined
  bail(subject: TriggerContext, name: 'slash/input-insert-reference', request: InsertReferenceRequest): true | undefined
  bail(subject: TriggerContext, name: 'slash/input-insert-text', request: InsertTextRequest): true | undefined
}
