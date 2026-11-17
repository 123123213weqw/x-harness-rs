import {objectValue} from '../shared/runtime-types'
export interface ProjectSignal {generation: object; repositoryIds: readonly string[]; reset: boolean; connected: boolean}
export interface ProjectEvents {subscribe(listener: (value: ProjectSignal) => void): () => void; current(): ProjectSignal|undefined}
/** Invalidation metadata only; no cached PR result, prompt, command or model work. */
export class ProjectEventFeed implements ProjectEvents {
  private listeners = new Set<(value: ProjectSignal) => void>()
  private latest: ProjectSignal|undefined
  private disposed = false
  current(): ProjectSignal|undefined {return this.latest}
  subscribe(listener: (value: ProjectSignal) => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener)}}
  receive(raw: unknown, generation: object|undefined): boolean {
    if (this.disposed || !generation) return false
    const v = objectValue(raw)
    if (Object.keys(v).length !== 3 || !Array.isArray(v.repositoryIds) || v.repositoryIds.length > 128 ||
        !v.repositoryIds.every((id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_+/=-]{8,128}$/.test(id)) ||
        new Set(v.repositoryIds).size !== v.repositoryIds.length || typeof v.reset !== 'boolean' || typeof v.connected !== 'boolean') return false
    if (!v.connected && (v.reset || v.repositoryIds.length > 0)) return false
    const value: ProjectSignal = {generation, repositoryIds: v.repositoryIds, reset: v.reset, connected: v.connected}
    if (!value.connected && this.latest?.generation === generation && !this.latest.connected) return true
    // Do not replay an old invalidation when a row mounts. Its initial readonly
    // query is already authoritative. Only connection availability is retained.
    this.latest = {...value, repositoryIds: [], reset: false}
    for (const listener of [...this.listeners]) {
      try {listener(value)} catch {console.error('[github-events] observer failed')}
    }
    return true
  }
  reset(): void {this.latest = undefined}
  dispose(): void {this.disposed = true; this.latest = undefined; this.listeners.clear()}
}
