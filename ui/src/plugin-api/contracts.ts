/** The plugin-center wire contract. Rust serialization is checked by
 * plugin_wire_contract + test-plugin-wire-contract.mjs, not assumed from names.
 * External replies are unknown until decoded; added server fields are tolerated.
 */
export type CatalogScope = 'public' | 'personal'
export interface PackageSource {
  source: string
  type: string
  url: string
  sha256: string
}
export interface CatalogEntry {
  name: string
  scope: string
  description: string
  descriptionI18n: Record<string, string>
  version: string
  category: string
  icon: string | null
  source: PackageSource
}
export interface SkillRecord {
  name: string
  description: string
  relativePath: string
  sha256: string
}
export interface InstalledPlugin {
  name: string
  version: string
  description: string
  digest: string
  enabled: boolean
  mcpEnabled: boolean
  mcpConfigSha256: string | null
  capabilities: string[]
  skills: SkillRecord[]
}
export interface PluginUpdate {
  name: string
  installedVersion: string
  availableVersion: string
  availableDigest: string
}
export interface McpServerPreview {
  server: string
  command: string
  args: string[]
  envKeys: string[]
  envSources: Record<string, string>
}
export interface RpcError {
  code: string
  message: string
  details: unknown
}
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }
export type EmptyArgs = Record<string, never>
export interface PluginRequests {
  'plugins/catalog': EmptyArgs
  'plugins/installed': EmptyArgs
  'plugins/updates': EmptyArgs
  'plugins/importCatalog': { content: string; scope?: CatalogScope }
  'plugins/install': { name: string }
  'plugins/enable': { name: string }
  'plugins/disable': { name: string }
  'plugins/uninstall': { name: string }
  'plugins/mcpPreview': { name: string }
  'plugins/mcpEnable': { name: string }
  'plugins/mcpDisable': { name: string }
}
export interface PluginResponses {
  'plugins/catalog': { plugins: CatalogEntry[] }
  'plugins/installed': { plugins: InstalledPlugin[] }
  'plugins/updates': { updates: PluginUpdate[] }
  'plugins/importCatalog': { plugins: CatalogEntry[] }
  'plugins/install': { plugin: InstalledPlugin }
  'plugins/enable': { plugin: InstalledPlugin }
  'plugins/disable': { plugin: InstalledPlugin }
  'plugins/uninstall': { ok: true }
  'plugins/mcpPreview': { servers: McpServerPreview[] }
  'plugins/mcpEnable': { plugin: InstalledPlugin }
  'plugins/mcpDisable': { plugin: InstalledPlugin }
}
export type PluginEndpoint = keyof PluginRequests
export type ReadEndpoint = 'plugins/catalog' | 'plugins/installed' | 'plugins/updates'
export type PluginArgs<E extends PluginEndpoint> = E extends ReadEndpoint
  ? [args?: PluginRequests[E]] : [args: PluginRequests[E]]
export type PluginCall = <E extends PluginEndpoint>(endpoint: E, ...args: PluginArgs<E>) => Promise<PluginResponses[E]>
/** Existing client-connection already unwraps ServerResponse; this is RpcResult. */
export interface RpcTransport {
  call(channel: '/api', endpoint: PluginEndpoint, payload: { args: object }): Promise<unknown>
}
