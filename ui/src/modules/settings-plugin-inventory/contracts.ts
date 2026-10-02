import type {ApiResult, SlotsService, Translation} from '../views-types'
/** Wire-only read model, matching the Host inventory Remote; never treated as installed plugins. */
export interface PluginInventoryEntry {
  readonly entryId: string; readonly moduleName: string; readonly enabled: boolean
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
}
export interface PluginInventorySnapshot {readonly entries: readonly PluginInventoryEntry[]}
export interface InventoryContext {
  effect(effect: () => void | (() => void), label: string): void
  slots: SlotsService
  locale: {register(namespace: string, values: {zh: Readonly<Record<string,string>>; en: Readonly<Record<string,string>>}): () => void; bind(namespace: string): Translation}
  remote: {pluginInventory: {list(): Promise<ApiResult<PluginInventorySnapshot>>}}
}
