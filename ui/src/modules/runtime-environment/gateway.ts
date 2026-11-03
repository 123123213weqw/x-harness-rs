/** Immutable-origin personal Gateway catalogue. No browser URL can select an
 * arbitrary upstream; no API/model/Host credential appears in this contract. */
export interface EnvironmentEntry { id: string; label: string; kind: 'local' | 'cloud'; href: string }
export interface EnvironmentCatalogue { version: 1; current: string; entries: readonly EnvironmentEntry[]; sessionMigration: false; workspaceSync: false; workspaceProfile?: { preset: 'local_code_remote_exec_v1'; state: 'pending' } }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function entry(value: unknown): value is EnvironmentEntry {
  if (!object(value) || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['id','label','kind','href'].includes(key)) || typeof value.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value.id)
    || typeof value.label !== 'string' || value.label.trim() === '' || value.label.length > 80 || /[\x00-\x1f\x7f]/.test(value.label)
    || (value.kind !== 'local' && value.kind !== 'cloud') || typeof value.href !== 'string') return false
  try { const url = new URL(value.href); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash && url.href === value.href } catch { return false }
}
export function parseCatalogue(value: unknown, origin: string): EnvironmentCatalogue | undefined {
  if (!object(value) || ![5,6].includes(Object.keys(value).length) || Object.keys(value).some(key => !['version','current','entries','sessionMigration','workspaceSync','workspaceProfile'].includes(key)) || value.version !== 1 || typeof value.current !== 'string'
    || value.sessionMigration !== false || value.workspaceSync !== false || !Array.isArray(value.entries)
    || !value.entries.length || value.entries.length > 8 || !value.entries.every(entry)) return undefined
  const profile = value.workspaceProfile
  if ('workspaceProfile' in value && (!object(profile) || Object.keys(profile).length !== 2
    || !Object.hasOwn(profile, 'preset') || !Object.hasOwn(profile, 'state')
    || profile.preset !== 'local_code_remote_exec_v1' || profile.state !== 'pending')) return undefined
  const entries = value.entries
  if (new Set(entries.map(e => e.id)).size !== entries.length || new Set(entries.map(e => e.href)).size !== entries.length
    || entries.filter(e => e.kind === 'local').length !== 1 || entries.find(e => e.id === value.current)?.href !== origin + '/') return undefined
  return { version: 1, current: value.current, entries, sessionMigration: false, workspaceSync: false, ...(profile === undefined ? {} : { workspaceProfile: { preset: 'local_code_remote_exec_v1', state: 'pending' } }) }
}
/** A pick opens another origin. It never rebinds a SessionManager or copies its
 * draft/history/attachment cache. A blocked popup is not a successful switch. */
export function openEnvironment(catalogue: EnvironmentCatalogue, id: string, open: (href: string) => Window | null): boolean {
  const target = catalogue.entries.find(e => e.id === id)
  if (target === undefined || id === catalogue.current) return false
  return open(target.href) !== null
}
