// Positive compile-time contract regression; never loaded in the product bundle.
import type { PluginCall, RpcResult, CatalogEntry, InstalledPlugin, PluginUpdate } from './contracts'
export function checkContract(call: PluginCall, entry: CatalogEntry, installed: InstalledPlugin, update: PluginUpdate, result: RpcResult<string>): void {
  void call('plugins/catalog')
  void call('plugins/updates')
  void call('plugins/enable', { name: 'github' })
  void call('plugins/importCatalog', { content: '{}', scope: 'personal' })
  if (result.ok) { void result.value } else { void result.error.message }
}
