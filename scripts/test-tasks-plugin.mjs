import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
import assert from 'node:assert/strict'
import vm from 'node:vm'

let registration
const sandbox = {
  window: {
    __ModuleLoader__: { load(value) { registration = value } },
  },
}
vm.createContext(sandbox)
vm.runInContext(ownedViewModuleTestInput('@xlang/xharness-client-ui-tasks'), sandbox)

const React = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
  Fragment: 'fragment',
  useEffect() {},
  useRef() { return { current: null } },
  useState(value) { return [value, () => {}] },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
}
const ReactDOM = { createPortal(element) { return element } }

let requests = []
let responses = new Map()
sandbox.fetch = async () => { throw Error('Tasks cannot access transport directly') }
sandbox.document = {
  getElementById() { return null },
  documentElement: { lang: 'zh-CN' },
  createElement() { return { style: {}, append() {}, remove() {} } },
  head: { append() {} },
  get body() { return this.createElement() },
}
sandbox.navigator = {}

const plugin = registration.factory((id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return ReactDOM
  if (id === '@xharness/dsh-client-ui-primitives') return Object.fromEntries([
    'IconSearchOutline16', 'IconFolderClose16', 'IconTrashOutline16',
    'IconEllipsisOutline16', 'IconChevronDownOutline14', 'IconChecklistOutline14',
  ].map((name) => [name, () => null]))
  throw new Error(`unexpected module dependency: ${id}`)
})

assert.equal(registration.id, '@xlang/xharness-client-ui-tasks')
assert.equal(JSON.stringify(plugin.inject), '["slots","locale","workCatalog"]')
assert.equal(typeof plugin.apply, 'function')

// Timestamps: the host sends epoch milliseconds; a seconds-scale value is
// tolerated so ordering never inverts if the wire unit changes.
assert.equal(plugin.normalizeTimestamp(1_770_000_000_000), 1_770_000_000_000)
assert.equal(plugin.normalizeTimestamp(1_770_000_000), 1_770_000_000_000)
assert.equal(plugin.normalizeTimestamp('nope'), 0)

// Titles prefer the frozen `title` projection, then fall back to the cwd
// leaf, then to the placeholder.
const t = (key) => key
assert.equal(
  plugin.sessionTitle({ projections: { values: { title: '修登录超时' } } }, t),
  '修登录超时',
)
assert.equal(plugin.sessionTitle({ cwd: '/srv/work/x-harness-rs' }, t), 'x-harness-rs')
assert.equal(plugin.sessionTitle({ cwd: 'C:\\repo\\app' }, t), 'app')
assert.equal(plugin.sessionTitle({}, t), 'untitled')

// Timeline grouping: pinned first, then calendar-day buckets off local
// midnight, blank sessions skipped, each bucket newest-first.
const now = Date.parse('2026-09-26T12:00:00')
const day = 24 * 60 * 60 * 1000
const at = (offsetDays) => now - offsetDays * day
const sessions = [
  { sessionId: 'blank', updatedAt: at(0.1), blank: true },
  { sessionId: 'today', updatedAt: at(0.2) },
  { sessionId: 'pinned-old', updatedAt: at(30) },
  { sessionId: 'yesterday', updatedAt: at(1.2) },
  { sessionId: 'this-week', updatedAt: at(4) },
  { sessionId: 'ancient', updatedAt: at(20) },
]
// Array prototypes differ across the vm realm boundary, so bucket contents
// are compared as JSON instead of with deepEqual.
const groups = plugin.groupSessions(sessions, ['pinned-old'], now)
const ids = (bucket) => JSON.stringify(bucket.map((s) => s.sessionId))
assert.equal(ids(groups.pinned), '["pinned-old"]')
assert.equal(ids(groups.today), '["today"]')
assert.equal(ids(groups.yesterday), '["yesterday"]')
assert.equal(ids(groups.last7), '["this-week"]')
assert.equal(ids(groups.earlier), '["ancient"]')

// Ordering inside a bucket is by recency regardless of input order.
const reordered = plugin.groupSessions(
  [sessions[1], { sessionId: 'today-older', updatedAt: at(0.5) }],
  [],
  now,
)
assert.equal(ids(reordered.today), '["today","today-older"]')

// Archived settings group by the durable workspace membership, not by a
// client-only title snapshot. Search/project filters and sorting compose.
const archivedSnapshots = {
  newer: { title: 'Fix browser', updatedAt: 200, workspaceId: 'project-a' },
  older: { title: 'Fix tests', updatedAt: 100, workspaceId: 'project-a' },
  orphan: { title: 'Loose chat', updatedAt: 150, workspaceId: null },
}
const archivedWorkspaces = [{ workspaceId: 'project-a', title: 'Alpha', sessionIds: ['newer', 'older'] }]
const archivedGroups = plugin.groupArchived(['orphan', 'older', 'newer'], archivedSnapshots, archivedWorkspaces)
assert.equal(JSON.stringify(archivedGroups.map((group) => group.ids)), '[["newer","older"],["orphan"]]')
assert.equal(JSON.stringify(plugin.groupArchived(['orphan', 'older', 'newer'], archivedSnapshots, archivedWorkspaces, 'FIX', 'project-a', 'oldest').map((group) => group.ids)), '[["older","newer"]]')
assert.equal(JSON.stringify(plugin.groupArchived(['orphan', 'older'], archivedSnapshots, archivedWorkspaces, '', '__other__').map((group) => group.ids)), '[["orphan"]]')

// UI actions call the injected runtime face, never hand-built HTTP envelopes.
const snapshot={phase:'ready',loading:false,error:null,sessions:[],workspaces:[],archivedSessionIds:[],archivedSessions:[]}
const command = async (method, payload) => {
  requests.push({method,payload})
  const failure=responses.get(method)
  if(failure)throw Error(failure)
}
const subscribers=new Set()
const publish=patch=>{Object.assign(snapshot,patch);for(const listener of subscribers)listener()}
const service={getSnapshot:()=>snapshot,subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},refresh:async()=>{},
  rename:(id,title)=>command('session.rename',{sessionId:id,title}),archive:id=>command('workspace.archiveSession',{sessionId:id}),
  unarchive:async id=>{await command('workspace.unarchiveSession',{sessionId:id});publish({sessions:[{sessionId:id,updatedAt:0}],archivedSessionIds:snapshot.archivedSessionIds.filter(value=>value!==id)})},fork:id=>command('session.fork',{sessionId:id}),deleteArchived:async id=>{await command('session.delete',{sessionId:id});publish({sessions:[],archivedSessionIds:snapshot.archivedSessionIds.filter(value=>value!==id)})}}
const slots=[]
const context={get:name=>name==='workCatalog'?service:undefined,effect:run=>run(),locale:{register(){}},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>slots.push({spec,component})}}
plugin.apply(context)
assert.equal(typeof plugin.rpc,'undefined','removed private HTTP compatibility helper')
// Failed mutations must be visible in the panel state, never surface as an
// unhandled rejection or create a phantom archived entry.
publish({sessions:[{
  sessionId: 'x', updatedAt: 1_770_000_000_000,
  projections: { values: { title: 'Still live' } },
}]})
responses.set('workspace.archiveSession','archive denied')
await plugin.store.archive('x')
assert.equal(plugin.store.actionError, 'archive denied')
assert.equal(plugin.store.sessions.length, 1)
assert.equal(plugin.store.snapshots.x, undefined)
assert.equal(plugin.store.busyId, null)

responses.set('session.rename','rename denied')
await plugin.store.rename('x', 'New title')
assert.equal(plugin.store.actionError, 'rename denied')
assert.equal(plugin.store.sessions[0].projections.values.title, 'Still live')
assert.equal(plugin.store.busyId, null)

responses.set('session.fork','fork denied')
await plugin.store.fork('x')
assert.equal(plugin.store.actionError, 'fork denied')
assert.equal(plugin.store.busyId, null)

// Restoring preserves the original identity; deleting requires an explicit
// confirmation and removes the archived snapshot only after the RPC succeeds.
publish({archivedSessionIds:['archived']})
plugin.store.snapshots.archived = { title: 'Original task' }
await plugin.store.restore('archived')
assert.equal(plugin.store.archivedIds.length, 0)
assert.equal(plugin.store.sessions[0].sessionId, 'archived')
assert.equal(plugin.store.snapshots.archived, undefined)

publish({archivedSessionIds:['delete-me']})
plugin.store.snapshots['delete-me'] = { title: 'Delete me' }
await plugin.store.deleteArchived('delete-me')
assert.equal(plugin.store.archivedIds.length, 1, 'delete is inert before confirmation')
plugin.store.deleteConfirmId = 'delete-me'
await plugin.store.deleteArchived('delete-me')
assert.equal(plugin.store.archivedIds.length, 0)
assert.equal(plugin.store.snapshots['delete-me'], undefined)
assert.equal(plugin.store.deleteConfirmId, null)

publish({archivedSessionIds:['batch-a', 'batch-b']})
plugin.store.snapshots['batch-a'] = { title: 'Batch A' }
plugin.store.snapshots['batch-b'] = { title: 'Batch B' }
const beforeBatch = requests.length
await plugin.store.deleteArchivedBatch(['batch-a', 'batch-b'])
assert.equal(requests.length, beforeBatch, 'bulk deletion requires confirmation')
plugin.store.deleteConfirmId = 'all'
await plugin.store.deleteArchivedBatch(['batch-a', 'batch-b'])
assert.equal(plugin.store.archivedIds.length, 0)
assert.equal(plugin.store.snapshots['batch-a'], undefined)
assert.equal(plugin.store.snapshots['batch-b'], undefined)
assert.equal(plugin.store.busyId, null)
assert.equal(requests.filter(({ method }) => method === 'session.delete').length, 3)

// Page registration and archive controls remain functional without a drawer.
const slotRegistrations = []
plugin.apply({
  get: name => name === 'workCatalog' ? service : undefined,
  effect() {},
  locale: { register() {} },
  slots: {
    inject(_name, register) { register() },
    register(options, component) { slotRegistrations.push({ options, component }) },
  },
})
function findClass(node, name) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  const rendered = typeof node.type === 'function' ? node.type(node.props) : node
  if (rendered !== node) return findClass(rendered, name)
  if (String(node.props?.className ?? '').split(' ').includes(name)) return node
  for (const child of node.children ?? []) {
    if (Array.isArray(child)) {
      for (const nested of child) {
        const found = findClass(nested, name)
        if (found) return found
      }
    } else {
      const found = findClass(child, name)
      if (found) return found
    }
  }
  return null
}
assert.deepEqual(slotRegistrations.map(({ options }) => options.name), ['work.center.tasks', 'settings.section'])
assert.equal(slotRegistrations[1].options.id, 'archived-chats')
publish({archivedSessionIds:['example']})
plugin.store.snapshots.example = { title: 'Saved conversation', updatedAt: Date.now() }
const archivedSettings = React.createElement(slotRegistrations[1].component)
assert.ok(findClass(archivedSettings, 'xhtask-settings-list'))
assert.ok(findClass(archivedSettings, 'xhtask-archived-item'))
const archivedRow = findClass(archivedSettings, 'xhtask-archived-item')
assert.ok(JSON.stringify(archivedRow).includes('Saved conversation'))
const page = React.createElement(slotRegistrations[0].component, {openSession() {}})
assert.equal(slotRegistrations[0].options.name, 'work.center.tasks')
assert.ok(findClass(page, 'xhtask-panel'))
assert.equal(findClass(page, 'xhtask-trigger'), null)
assert.equal(findClass(page, 'xhtask-panel-wrap'), null)
for (const key of ['open','closing','closeTimer','setOpen','finishClose']) assert.equal(key in plugin.store, false)
console.log('tasks plugin: assertions passed')
