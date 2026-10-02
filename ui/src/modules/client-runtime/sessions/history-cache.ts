import {isRecord} from '../value-guards'
import type { SessionId } from '../../client-connection/index'
import type { Session } from './session'

/** History residency is UI memory policy, never model-context compaction. */
export interface HistoryCacheLimits { maxInactiveSessions: number; maxInactiveBytes: number }
export interface HistoryCacheStats {
  inactiveSessions: number
  estimatedInactiveBytes: number
  protectedSessions: number
  evictions?: number
}
interface Entry { session: Session; lastAccess: number; bytes: number; dirty: boolean }
export interface HistoryCacheManager {
  isCurrent(id: SessionId): boolean
  hasPendingInteractions(id: SessionId): boolean
}
const defaults = Object.freeze({ maxInactiveSessions: 6, maxInactiveBytes: 64 * 1024 * 1024 })

/** Iterative conservative payload weight; cycles and deeply nested data are safe. */
function weight(value: unknown): number {
  let bytes = 0
  const stack: unknown[] = [value], seen = new WeakSet<object>()
  while (stack.length && bytes <= defaults.maxInactiveBytes) {
    const item = stack.pop()
    if (typeof item === 'string') bytes += 24 + item.length * 2
    else if (isRecord(item)) {
      if (seen.has(item)) continue
      seen.add(item)
      bytes += 64
      for (const key of Object.keys(item)) {
        bytes += 16 + key.length * 2
        stack.push(item[key])
      }
    } else bytes += 8
  }
  return bytes
}

/** LRU owner for idle, inactive Session windows; streaming paths only mark dirty. */
export class HistoryCache {
  readonly limits: HistoryCacheLimits = { ...defaults }
  private readonly entries = new Map<SessionId, Entry>()
  private clock = 0
  private scheduled = false
  private evictions = 0
  private lastStats: HistoryCacheStats = { inactiveSessions: 0, estimatedInactiveBytes: 0, protectedSessions: 0 }
  constructor(readonly manager: HistoryCacheManager) {}
  track(session: Session): void {
    if (this.entries.has(session.sessionId)) return
    this.entries.set(session.sessionId, { session, lastAccess: ++this.clock, bytes: 0, dirty: true })
    session.xhHistoryOwner = this
    this.schedule()
  }
  touch(id: SessionId | undefined): void {
    const entry = id === undefined ? undefined : this.entries.get(id)
    if (entry) entry.lastAccess = ++this.clock
    this.schedule()
  }
  changed(session: Session): void {
    const entry = this.entries.get(session.sessionId)
    if (entry) entry.dirty = true
    this.schedule()
  }
  forget(id: SessionId): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.session.xhHistoryOwner = undefined
    this.entries.delete(id)
  }
  protected(session: Session): boolean {
    return this.manager.isCurrent(session.sessionId)
      || this.manager.hasPendingInteractions(session.sessionId)
      || session.historyResidencyProtected()
  }
  schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.trim() })
  }
  trim(): HistoryCacheStats {
    const candidates: Entry[] = []
    let bytes = 0, protectedSessions = 0
    for (const entry of this.entries.values()) {
      const session = entry.session
      if (session.historyResidencyCold()) continue
      if (this.protected(session)) { protectedSessions++; continue }
      if (entry.dirty) { entry.bytes = weight(session.historyPayload()); entry.dirty = false }
      bytes += entry.bytes
      candidates.push(entry)
    }
    candidates.sort((a, b) => a.lastAccess - b.lastAccess)
    let count = candidates.length
    for (const entry of candidates) {
      if (count <= this.limits.maxInactiveSessions && bytes <= this.limits.maxInactiveBytes) break
      if (this.protected(entry.session) || !entry.session.unloadHistory()) continue
      bytes -= entry.bytes
      entry.bytes = 0
      entry.dirty = true
      count--
      this.evictions++
    }
    this.lastStats = { inactiveSessions: count, estimatedInactiveBytes: bytes, protectedSessions, evictions: this.evictions }
    return this.lastStats
  }
}
