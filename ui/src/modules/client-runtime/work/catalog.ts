import type {IApiClient, RpcError, RpcResult, ArchivedSessionSummary, SessionId} from '../../client-connection/index'
import {SessionId as sessionIdOf} from '../../client-connection/contracts/core/session/types'
import type {IWorkCatalog, WorkCatalogSnapshot} from '../contract/work-catalog'
import type {SessionListState} from '../sessions/service'
import type {WorkspaceListState} from '../workspaces/service'
import type {ObservableSnapshot} from '../contract/store'
import {Notifier} from '../sessions/notifier'

export interface WorkSessionsPort {
  readonly list: ObservableSnapshot<SessionListState>
  refresh(): Promise<void>
  forgetDeletedSessions(ids: readonly SessionId[]): void
  catalogStatus(): {state: 'idle' | 'loading' | 'error'; error: RpcError | null}
  fork(opts: {sessionId: SessionId}): Promise<SessionId>
}
export interface WorkWorkspacesPort {
  readonly list: ObservableSnapshot<WorkspaceListState>
  refresh(): Promise<void>
  archiveSession(id: SessionId): Promise<void>
  forgetDeletedSessions(ids: readonly SessionId[]): void
  archivedSummaries(): readonly ArchivedSessionSummary[]
}
function valueOf<T>(result: RpcResult<T>): T {
  if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
function readerWait<T>(job: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return job
  if (signal.aborted) return Promise.reject(new DOMException('Reader cancelled', 'AbortError'))
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('Reader cancelled', 'AbortError'))
    signal.addEventListener('abort', aborted, {once: true})
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** Single read projection over existing Session/Workspace owners, not another event pump. */
export class WorkCatalog implements IWorkCatalog {
  private disposed = false
  private inflight: Promise<void> | undefined
  private snapshot: WorkCatalogSnapshot
  private readonly notifier = new Notifier(() => {if (!this.disposed) this.snapshot = this.project()})
  private readonly unsubscribers: (() => void)[]
  constructor(private readonly api: Pick<IApiClient, 'sessions' | 'workspace'>,
    private readonly sessions: WorkSessionsPort, private readonly workspaces: WorkWorkspacesPort) {
    this.snapshot = this.project()
    this.unsubscribers = [sessions.list.subscribe(() => this.changed()), workspaces.list.subscribe(() => this.changed())]
  }
  readonly subscribe = (listener: () => void): (() => void) => this.notifier.subscribe(() => {if (!this.disposed) listener()})
  readonly getSnapshot = (): WorkCatalogSnapshot => {this.notifier.ensureFresh(); return this.snapshot}
  private changed(): void {if (!this.disposed) this.notifier.markDirty()}
  private project(): WorkCatalogSnapshot {
    const sessions = this.sessions.list.getSnapshot(), workspaces = this.workspaces.list.getSnapshot()
    const status = this.sessions.catalogStatus()
    return {
      sessions: sessions.ids.flatMap(id => {
        const row = sessions.byId[id]
        return row === undefined ? [] : [{sessionId: id, blank: row.blank, running: row.running,
          updatedAt: row.updatedAt, ...(row.cwd === undefined ? {} : {cwd: row.cwd}),
          projections: {values: {...row.projectionValues, ...(row.title === undefined ? {} : {title: row.title})}}}]
      }),
      workspaces: workspaces.items, archivedSessionIds: workspaces.archivedSessionIds,
      archivedSessions: this.workspaces.archivedSummaries(),
      phase: sessions.phase === 'ready' && workspaces.phase === 'ready' ? 'ready' : 'pending',
      loading: this.inflight !== undefined || status.state === 'loading' || workspaces.state === 'loading',
      error: status.error?.message ?? workspaces.error?.message ?? null,
    }
  }
  refresh(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(Error('Work catalog disposed'))
    if (signal?.aborted) return Promise.reject(new DOMException('Reader cancelled', 'AbortError'))
    if (this.inflight === undefined) {
      this.inflight = Promise.all([this.sessions.refresh(), this.workspaces.refresh()]).then(() => {
        if (this.disposed) throw Error('Work catalog disposed')
        const error = this.sessions.catalogStatus().error ?? this.workspaces.list.getSnapshot().error
        if (error !== null) throw Error(`${error.code}: ${error.message}`)
      }).finally(() => {this.inflight = undefined; this.changed()})
      this.changed()
    }
    return readerWait(this.inflight, signal)
  }
  private activeId(id: string): SessionId {
    if (this.disposed) throw Error('Work catalog disposed')
    if (id.trim() === '') throw Error('Session id cannot be empty')
    return sessionIdOf(id)
  }
  async rename(id: string, title: string): Promise<void> {
    valueOf((await this.api.sessions.rename({sessionId: this.activeId(id), title})).result)
    await this.sessions.refresh()
  }
  async archive(id: string): Promise<void> {await this.workspaces.archiveSession(this.activeId(id)); await this.sessions.refresh()}
  async unarchive(id: string): Promise<void> {
    valueOf((await this.api.workspace.unarchiveSession({sessionId: this.activeId(id)})).result)
    await this.refresh()
  }
  async fork(id: string): Promise<void> {await this.sessions.fork({sessionId: this.activeId(id)}); await this.refresh()}
  async deleteArchived(id: string): Promise<void> {
    const result = valueOf((await this.api.sessions.delete({sessionId: this.activeId(id)})).result)
    // Idempotent false means already absent, not an invitation to re-run deletion.
    if (typeof result.deleted !== 'boolean') throw Error('Invalid delete result')
    // Publish Host-confirmed tombstones before any baseline read. A pending
    // pre-delete refresh or a missing stream frame cannot resurrect these ids.
    if (this.disposed) return
    const deletedIds = [...new Set([sessionIdOf(id), ...(result.deletedSessionIds ?? [])])]
    this.sessions.forgetDeletedSessions(deletedIds)
    this.workspaces.forgetDeletedSessions(deletedIds)
    this.changed()
    // The mutation has committed; reconciliation errors belong to the feed,
    // not to the deletion result, and must not stall a bulk delete.
    void this.refresh().catch(() => {})
  }
  dispose(): void {this.disposed = true; for (const unsubscribe of this.unsubscribers) unsubscribe()}
}
