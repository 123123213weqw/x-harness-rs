import type * as React from 'react'

export type Translation = (key: string, values?: Readonly<Record<string, string | number>>) => string
export interface EffectContext {
  effect(effect: () => void | (() => void), label: string): void
}
export interface LocaleService {
  register(namespace: string, labels: { zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>> }): void
  bind(namespace: string): Translation
}
export interface SlotSpec<Args extends unknown[] = []> {
  name: string
  id?: string
  key?: string
  order?: number
  locale?: string
  label?: () => string
  inject?: (...args: Args) => unknown
}
export interface SlotsService {
  inject(name: string, effect: () => void): void
  register<P, Args extends unknown[] = []>(spec: SlotSpec<Args>, component: React.ComponentType<P>): void
}
export interface PageContext extends EffectContext {
  locale: LocaleService
  slots: SlotsService
}
export interface ObservableStore<T> {
  subscribe(listener: () => void): () => void
  getSnapshot(): T
}
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function objectValue(value: unknown): Record<string, unknown> {
  return isObjectRecord(value) ? value : {}
}
export function errorText(error: unknown): string {
  const record = objectValue(error)
  const rpc = objectValue(record.rpcError)
  return typeof rpc.message === 'string' ? rpc.message : typeof record.message === 'string' ? record.message : String(error)
}
export function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}
export function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export interface SessionEvent { type: string; seq: number; time: number; data: unknown }
export interface EventLocation {
  kind: 'step' | 'turn' | string
  turn?: { turn: number }
  step?: { step: number }
}
export interface ProjectionContext<S> { key: string; kind: string; id: string; state: S | undefined }
export interface EventMatch { event: SessionEvent; location: EventLocation | undefined }
export interface ViewNode<S> { key: string; kind: string; id: string; target: string; anchorSeq: number; data: S }
export interface ConversationEventDefinition<S> {
  kind: string
  target: string
  match(event: SessionEvent): { id: string; role: string } | null
  start(context: ProjectionContext<S>, match: EventMatch): S
  update(context: ProjectionContext<S>): S | undefined
  buildViewNode(context: ProjectionContext<S>): ViewNode<S> | null
}
export interface ConversationEvents { register<S>(definition: ConversationEventDefinition<S>): void }
export interface ViewBuilder<S, T> {
  empty: T
  replace(change: { nodes: ViewNode<S>[] }): T
  apply(change: { upserts: ViewNode<S>[] }): T
  snapshot(): T
}
export interface ConversationViews { register<S, T>(definition: { target: string; create(): ViewBuilder<S, T> }): void }
