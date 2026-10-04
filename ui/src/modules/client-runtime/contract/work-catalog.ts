/** Work pages consume this runtime face, never transport envelopes or history. */
import type {ArchivedSessionSummary, SessionId, WorkspaceView} from '../../client-connection/index'
import type {SessionProjectionMap} from '../../client-connection/contracts/session/session-projection/types'
import type {ObservableSnapshot} from './store'
export interface WorkSession {
  sessionId: SessionId
  blank: boolean
  running: boolean
  updatedAt: number
  cwd?: string
  projections: {values: Readonly<Partial<SessionProjectionMap>>}
}
export interface WorkCatalogSnapshot {
  sessions: readonly WorkSession[]
  workspaces: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
  archivedSessions: readonly ArchivedSessionSummary[]
  phase: 'pending' | 'ready'
  loading: boolean
  error: string | null
}
export interface IWorkCatalog extends ObservableSnapshot<WorkCatalogSnapshot> {
  /** Cancels only this reader's wait, never another page's shared baseline pull. */
  refresh(signal?: AbortSignal): Promise<void>
  rename(id: string, title: string): Promise<void>
  archive(id: string): Promise<void>
  unarchive(id: string): Promise<void>
  fork(id: string): Promise<void>
  deleteArchived(id: string): Promise<void>
}
