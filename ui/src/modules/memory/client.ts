import type {ClientConnectionRpc} from '../client-connection/rpc-contracts'
import {objectValue} from '../shared/runtime-types'
export type MemoryScope = {scope: 'global'} | {workspaceId: string}
export type Mode = 'off'|'manual'|'auto'
export interface Workspace {id: string; title: string; path: string}
export interface MemoryView {
  available: boolean; mode: Mode|null; settingsVersion: string|null; version: string|null
  content: string; tooLarge: boolean; invalidUtf8: boolean; settingsError: string
}
export class MemoryClient {
  constructor(private readonly rpc: ClientConnectionRpc) {}
  private async call(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const result = await this.rpc.call('/api', endpoint, payload, AbortSignal.any([signal, AbortSignal.timeout(20_000)]))
    if (!result.ok) throw Error(result.error.message)
    return result.value
  }
  async workspaces(signal: AbortSignal): Promise<Workspace[]> {
    const reply = objectValue(await this.call('workspace.list', {}, signal))
    if (!Array.isArray(reply.items)) throw Error('Invalid workspace response')
    return reply.items.map((raw: unknown) => {
      const row = objectValue(raw)
      if (typeof row.workspaceId !== 'string' || typeof row.title !== 'string' || typeof row.path !== 'string') throw Error('Invalid workspace')
      return {id: row.workspaceId, title: row.title, path: row.path}
    })
  }
  async view(scope: MemoryScope, signal: AbortSignal): Promise<MemoryView> {
    const row = objectValue(await this.call('workspace/memory', {...scope, action: 'view'}, signal))
    if (row.available === false) return {available: false, mode: null, content: '', version: null, settingsVersion: null, tooLarge: false, invalidUtf8: false, settingsError: ''}
    const version = (v: unknown): v is string|null => v === null || typeof v === 'string'
    if (row.available !== true || !version(row.version) || !version(row.settingsVersion) || typeof row.content !== 'string' ||
        !(row.mode === null || row.mode === 'off' || row.mode === 'manual' || row.mode === 'auto')) throw Error('Invalid memory response')
    return {available: true, mode: row.mode, content: row.content, version: row.version,
      settingsVersion: row.settingsVersion, tooLarge: row.tooLarge === true, invalidUtf8: row.invalidUtf8 === true,
      settingsError: typeof row.settingsError === 'string' ? row.settingsError : ''}
  }
  async mutate(scope: MemoryScope, change: {action: 'save'; content: string; version: string|null}|{action: 'clear'; version: string|null}|{action: 'configure'; mode: Mode; settingsVersion: string|null}, signal: AbortSignal): Promise<string> {
    const reply = objectValue(await this.call('workspace/memory', {...scope, ...change}, signal))
    if (reply.saved !== true || typeof reply.version !== 'string') throw Error('Invalid memory save response')
    return reply.version
  }
}
