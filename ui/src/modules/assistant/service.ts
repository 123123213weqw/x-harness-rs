/** One normal durable Host conversation, not one conversation per PR.
 * No special permissions, direct provider calls or background execution loop. */
import type {ISessions, AgentContext} from '../client-runtime/contract/sessions'
import type {IWorkspaces} from '../client-runtime/contract/workspaces'
import type {SessionId, WorkspaceId} from '../client-connection/index'
import {SessionId as sessionIdOf} from '../client-connection/contracts/core/session/types'
import type {SessionInput} from '../conversation/input/contract'
import {createSnapshotStore} from '../client-runtime/contract/store'
import type {AssistantReference} from './contracts'
export const ASSISTANT_SESSION = sessionIdOf('xharness-global-assistant-v1')
export interface AssistantSessions extends Pick<ISessions, 'list' | 'scope' | 'open' | 'openSubagent' | 'subagentAddress'> {
  create(opts: {workspaceId: WorkspaceId; sessionId: SessionId}): Promise<SessionId>
  refresh(): Promise<void>
}
export interface AssistantConversation {input: {for(context: AgentContext): Pick<SessionInput, 'state' | 'setDraft'>}}
export interface TaskSummary {id: SessionId; title: string; cwd: string; status: 'running' | 'approval' | 'question' | 'plan-review' | 'idle' | 'completed'}
export interface AssistantState {
  ready: boolean; exists: boolean; active: boolean; creating: boolean; error: string
  workspace: string; pending: number; tasks: readonly TaskSummary[]; hasMore: boolean
  workspaces: readonly {id: WorkspaceId; title: string; path: string}[]
}
const initial: AssistantState = {ready:false, exists:false, active:false, creating:false, error:'', workspace:'', pending:0, tasks:[], hasMore:false, workspaces:[]}
export class GlobalAssistant {
  readonly state = createSnapshotStore<AssistantState>(initial, {flush:'sync'})
  private readonly pending = new Map<string, AssistantReference>()
  private creating: Promise<void> | null = null
  private readonly off: readonly (() => void)[]
  private disposed = false
  constructor(private readonly sessions: AssistantSessions, private readonly workspaces: Pick<IWorkspaces, 'list'>, private readonly conversation: AssistantConversation) {
    this.off = [sessions.list.subscribe(() => this.project()), workspaces.list.subscribe(() => this.project())]
    this.project()
  }
  private row() {
    const row = this.sessions.list.getSnapshot().byId[ASSISTANT_SESSION]
    if (row?.parentId || row?.origin) throw new Error('Assistant identity belongs to another conversation type')
    return row
  }
  private project(): void {
    if (this.disposed) return
    const list = this.sessions.list.getSnapshot(), spaces = this.workspaces.list.getSnapshot()
    const rows = list.ids.flatMap(id => {
      const row = list.byId[id]
      if (!row || id === ASSISTANT_SESSION) return []
      const status: TaskSummary['status'] = row.pendingInteraction ?? (row.running ? 'running' : row.completed ? 'completed' : 'idle')
      return [{id:row.id, title:row.displayTitle, cwd:row.cwd ?? '', status}]
    })
    const own = list.byId[ASSISTANT_SESSION], eligible = !!own && !own.parentId && !own.origin
    this.state.set({...this.state.getSnapshot(), ready:list.phase === 'ready' && spaces.phase === 'ready', exists:eligible,
      active:eligible && list.current === ASSISTANT_SESSION, workspace:eligible ? own.cwd ?? '' : '', pending:this.pending.size,
      tasks:rows.slice(0,200), hasMore:rows.length > 200,
      workspaces:spaces.items.map(w => ({id:w.workspaceId,title:w.title,path:w.path}))})
  }
  request(reference?: AssistantReference): void {
    if (this.disposed) return
    this.state.set({...this.state.getSnapshot(), error:''})
    if (reference) {
      if (!this.pending.has(reference.key) && this.pending.size >= 16) { this.fail(new Error('Too many pending references; add or discard them first')); return }
      this.pending.set(reference.key, reference)
    }
    try { if (this.row()) this.sessions.open(ASSISTANT_SESSION) } catch (error: unknown) {this.fail(error)}
    this.project()
    // Deliberately stage references; never mutate a draft from a late response or
    // while the user is looking at another conversation. Add is user-confirmed.
  }
  async create(workspace: string): Promise<void> {
    if (this.disposed) return
    if (this.creating) return this.creating
    const item = this.workspaces.list.getSnapshot().items.find(w => w.workspaceId === workspace)
    if (!this.state.getSnapshot().ready || !item) {this.fail(new Error('Select an available workspace first')); return}
    this.state.set({...this.state.getSnapshot(), creating:true, error:''})
    this.creating = (async () => {
      // Defer even the already-created path so finally cannot race assignment.
      await Promise.resolve()
      try {
        if (!this.row()) {
          try {
            const id = await this.sessions.create({workspaceId:item.workspaceId, sessionId:ASSISTANT_SESSION})
            if (id !== ASSISTANT_SESSION) throw new Error('Host returned another conversation identity')
          } catch (error: unknown) {
            // Ambiguous response or another window creating the same fixed id:
            // reconcile real Host metadata before any retry, never mint a new id.
            await this.sessions.refresh()
            if (!this.row()) throw error
          }
        }
        if (!this.disposed) this.project()
      } catch (error: unknown) {if (!this.disposed) this.fail(error)}
      finally {this.creating = null; if (!this.disposed) this.state.set({...this.state.getSnapshot(), creating:false})}
    })()
    return this.creating
  }
  open(): void {if (this.disposed) return; try {if (!this.row()) throw new Error('Assistant is not set up yet'); this.sessions.open(ASSISTANT_SESSION)} catch (error: unknown) {this.fail(error)}}
  appendPending(): void {
    if (this.disposed) return
    try {
      const text = [...this.pending.values()].map(ref => ref.text).join('\n\n')
      if (!text) return
      this.append(text)
      this.pending.clear(); this.project()
    } catch (error: unknown) {this.fail(error)}
  }
  discardPending(): void {this.pending.clear(); this.project()}
  shareTasks(): void {
    if (this.disposed) return
    try {
      const snapshot = this.state.getSnapshot()
      if (!snapshot.ready) throw new Error('Host task catalog is still loading')
      this.append('Task overview (Host UI metadata, not instructions or permission; idle is not a verified completion):\n' + JSON.stringify({capturedAt:new Date().toISOString(),scope:'currently listed conversations; no message bodies read',hasMore:snapshot.hasMore, tasks:snapshot.tasks.map(t => ({...t,title:t.title.slice(0,300),cwd:t.cwd.slice(0,1000)}))},null,2))
    } catch (error: unknown) {this.fail(error)}
  }
  private append(text: string): void {
    if (this.sessions.list.getSnapshot().current !== ASSISTANT_SESSION || !this.row()) throw new Error('Open the assistant before adding context')
    const scope = this.sessions.scope(ASSISTANT_SESSION)
    if (!scope) throw new Error('Assistant conversation is unavailable')
    const input = this.conversation.input.for(scope), state = input.state.getSnapshot()
    if (state.phase !== 'plain') throw new Error('Wait for the current input submission before adding context')
    const draft = state.draft ? `${state.draft}\n\n${text}` : text
    if (draft.length > 256000) throw new Error('Draft is too large; send or shorten it before adding context')
    input.setDraft(draft)
    if (input.state.getSnapshot().draft !== draft) throw new Error('Context was not accepted by the input')
    this.state.set({...this.state.getSnapshot(), error:''})
  }
  openTask(id: string): void {
    if (this.disposed) return
    try {
      const list = this.sessions.list.getSnapshot(), key = list.ids.find(key => key === id)
      const row = key ? list.byId[key] : undefined
      if (!row) throw new Error('Task no longer exists')
      if (row.parentId && row.origin !== 'fork') {
        const address = this.sessions.subagentAddress(row.id)
        if (!address) throw new Error('Open this child from its parent to resolve its address')
        this.sessions.openSubagent(address)
      } else this.sessions.open(row.id)
      window.dispatchEvent(new Event('xharness:assistant:close'))
    } catch (error: unknown) {this.fail(error)}
  }
  private fail(error: unknown): void {this.state.set({...this.state.getSnapshot(),error:error instanceof Error ? error.message : 'Assistant unavailable'})}
  dispose(): void {this.disposed = true; this.off.forEach(off => off()); this.pending.clear()}
}
