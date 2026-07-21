import type { ClientModuleLoader } from '../client-modules/manifest'

/** Exact lifecycle surfaces used by HMR, independent of Node-side Cordis types. */
export interface Fiber {
  runtime: { callback: unknown } | null
  inertia?: Promise<unknown>
  await(): Promise<unknown>
}
export interface Entry {
  options: { name?: string }
  ctx: { registry: { delete(callback: unknown): unknown } }
  fiber?: Fiber
  refresh(): Promise<unknown>
}
export interface Loader { entries(): Iterable<Entry> }
export interface HmrContext {
  modules: ClientModuleLoader
  loader: Loader
  logger: { warn(message: string): void; error(error: unknown): void }
  effect(effect: () => () => void, label: string): unknown
}
