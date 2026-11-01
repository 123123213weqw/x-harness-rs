import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeTestApi } from './runtime-source-test-harness.mjs'

const { SessionManager, WorkspaceRuntime } = runtimeTestApi()
const reply = value => ({ result: { ok: true, value } })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const metadata = blank => ({ blank, restoring: false, lastPromptAt: blank ? null : 1 })

function fixture({ blank = true, projections } = {}) {
  let rows = [{ sessionId: 'old', cwd: '/workspace', running: false, blank, updatedAt: 1, ...projections && { projections } }]
  const created = [], opened = []
  const api = { sessions: {
    list: async () => reply({ items: rows }),
    create: async payload => { created.push(payload); return reply({ sessionId: 'fresh' }) },
    history: async () => reply({ events: [], hasMore: false, projections: { asOfSeq: 30, values: { sessionListMetadata: metadata(false) } } }),
  } }
  const manager = new SessionManager(api, {})
  const port = {
    list: {
      subscribe: listener => manager.subscribe(listener),
      getSnapshot: () => {
        const { items, current, phase } = manager.getListSnapshot()
        return { ids: items.map(row => row.sessionId), byId: Object.fromEntries(items.map(row => [row.sessionId, { ...row, id: row.sessionId }])), current, phase }
      },
    },
    create: async opts => { const result = await manager.create(opts); assert.equal(result.ok, true); return result.value.sessionId },
    open: id => { opened.push(id); manager.select(id) },
    clear: () => manager.clearSelection(),
  }
  const workspace = new WorkspaceRuntime({ reflect: { provide() {} } }, api, port)
  workspace.handleHostEnvelope({ rpcId: 'workspace', payload: { type: 'host/workspace-changed', workspace: {
    workspaceId: 'w', path: '/workspace', title: 'Workspace', sessionIds: ['old'], createdAt: '1', updatedAt: '1',
  } } })
  const push = (seq, blank) => manager.handleMuxEnvelope({ rpcId: 'projection-' + seq, payload: { type: 'session/projection', sessionId: 'old', key: 'sessionListMetadata', value: metadata(blank), seq } })
  return { manager, workspace, created, opened, push, setRows: next => { rows = next } }
}

test('New session does not reuse an old conversation corrected by a live metadata projection', async () => {
  const f = fixture(); await f.manager.refreshList()
  f.push(20, false)
  assert.equal(f.manager.getListSnapshot().items[0].blank, false)
  f.workspace.startSession('w'); await tick()
  assert.deepEqual(f.opened, ['fresh'])
  assert.equal(f.created.length, 1)
  assert.equal(f.created[0].workspaceId, 'w')
})

test('history metadata corrects both the instance and blank-session reuse without a list refresh', async () => {
  const f = fixture(); await f.manager.refreshList()
  const session = f.manager.get('old'); await session.open(); await tick()
  assert.equal(session.getSnapshot().blank, false)
  assert.equal(await f.workspace.connectWorkspace('w'), 'fresh')
})

test('a contradictory list baseline cannot certify old history as reusable', async () => {
  const f = fixture({ projections: { asOfSeq: 20, values: { sessionListMetadata: metadata(false) } } })
  await f.manager.refreshList()
  assert.equal(await f.workspace.connectWorkspace('w'), 'fresh')
})

test('stale blank projections and stale list refreshes cannot resurrect an engaged session', async () => {
  const f = fixture(); await f.manager.refreshList()
  f.push(20, false); f.push(19, true)
  await f.manager.refreshList(); await tick()
  assert.equal(f.manager.getListSnapshot().items[0].blank, false)
  assert.equal(await f.workspace.connectWorkspace('w'), 'fresh')
})

test('real empty drafts still reuse, and concurrent creates remain coalesced', async () => {
  const f = fixture(); await f.manager.refreshList()
  assert.equal(await f.workspace.connectWorkspace('w'), 'old')
  assert.equal(f.created.length, 0)
  f.push(20, false)
  const ids = await Promise.all([f.workspace.connectWorkspace('w'), f.workspace.connectWorkspace('w')])
  assert.deepEqual(ids, ['fresh', 'fresh'])
  assert.equal(f.created.length, 1)
})

test('metadata arriving before a session-added frame still excludes old history', async () => {
  const f = fixture(); f.setRows([]); await f.manager.refreshList()
  f.push(20, false); await tick()
  f.manager.handleHostEnvelope({ rpcId: 'added', payload: {
    type: 'host/session-added', sessionId: 'old', blank: true, cwd: '/workspace',
  } })
  assert.equal(await f.workspace.connectWorkspace('w'), 'fresh')
})

test('a genuinely empty legacy session becomes reusable after authoritative catalogue repair', async () => {
  const f = fixture({ blank: false }); await f.manager.refreshList()
  f.setRows([{ sessionId: 'old', cwd: '/workspace', running: false, blank: true, updatedAt: 1,
    projections: { asOfSeq: 20, values: { sessionListMetadata: metadata(true) } } }])
  await f.manager.refreshList()
  assert.equal(await f.workspace.connectWorkspace('w'), 'old')
  assert.equal(f.created.length, 0)
})
