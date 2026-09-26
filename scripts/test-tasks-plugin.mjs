import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let registration
const sandbox = {
  window: {
    __ModuleLoader__: { load(value) { registration = value } },
  },
}
let reducedMotion = false
let nextCloseTimer = 0
const closeTimers = new Map()
sandbox.window.matchMedia = () => ({ matches: reducedMotion })
sandbox.window.setTimeout = (callback, delay) => {
  assert.equal(delay, 1000, 'close timer is only a watchdog')
  const id = ++nextCloseTimer
  closeTimers.set(id, callback)
  return id
}
sandbox.window.clearTimeout = (id) => closeTimers.delete(id)
vm.createContext(sandbox)
vm.runInContext(
  await readFile(
    new URL('../ui/plugins/@xlang/xharness-client-ui-tasks/client.js', import.meta.url),
    'utf8',
  ),
  sandbox,
)

const React = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
  Fragment: 'fragment',
  useEffect() {},
  useRef() { return { current: null } },
  useState(value) { return [value, () => {}] },
}
const ReactDOM = { createPortal(element) { return element } }

let requests = []
let responses = new Map()
sandbox.fetch = async (url, options) => {
  requests.push({ url, body: JSON.parse(options.body) })
  const key = options.body
  const scripted = responses.get(key)
  if (scripted !== undefined) {
    return { ok: true, status: 200, json: async () => scripted }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ type: 'server-response', result: { ok: true, value: null } }),
  }
}
sandbox.document = {
  documentElement: { lang: 'zh-CN' },
  createElement() { return { style: {}, append() {}, remove() {} } },
  head: { append() {} },
  get body() { return this.createElement() },
}
sandbox.navigator = {}

const plugin = registration.factory((id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return ReactDOM
  throw new Error(`unexpected module dependency: ${id}`)
})

assert.equal(registration.id, '@xlang/xharness-client-ui-tasks')
assert.equal(JSON.stringify(plugin.inject), '["slots","locale"]')
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

// RPC calls use the frozen client-request envelope and surface failure text.
requests = []
responses = new Map([[JSON.stringify({ type: 'client-request', rpcId: 'xharness-tasks-1', method: 'session.list', payload: {} }), { result: { ok: true, value: { items: [] } } }]])
const value = await plugin.rpc('session.list', {})
assert.deepEqual(value, { items: [] })
assert.equal(requests[0].url, '/api/session.list')
assert.equal(requests[0].body.type, 'client-request')

responses.set(
  JSON.stringify({ type: 'client-request', rpcId: 'xharness-tasks-2', method: 'workspace.archiveSession', payload: { sessionId: 'x' } }),
  { result: { ok: false, error: { code: 'session/not-found', message: 'session "x" was not found' } } },
)
await assert.rejects(
  () => plugin.rpc('workspace.archiveSession', { sessionId: 'x' }),
  /was not found/,
)

// Failed mutations must be visible in the panel state, never surface as an
// unhandled rejection or create a phantom archived entry.
plugin.store.sessions = [{
  sessionId: 'x', updatedAt: 1_770_000_000_000,
  projections: { values: { title: 'Still live' } },
}]
responses.set(
  JSON.stringify({ type: 'client-request', rpcId: 'xharness-tasks-3', method: 'workspace.archiveSession', payload: { sessionId: 'x' } }),
  { result: { ok: false, error: { message: 'archive denied' } } },
)
await plugin.store.archive('x')
assert.equal(plugin.store.actionError, 'archive denied')
assert.equal(plugin.store.sessions.length, 1)
assert.equal(plugin.store.snapshots.x, undefined)
assert.equal(plugin.store.busyId, null)

responses.set(
  JSON.stringify({ type: 'client-request', rpcId: 'xharness-tasks-4', method: 'session.rename', payload: { sessionId: 'x', title: 'New title' } }),
  { result: { ok: false, error: { message: 'rename denied' } } },
)
await plugin.store.rename('x', 'New title')
assert.equal(plugin.store.actionError, 'rename denied')
assert.equal(plugin.store.sessions[0].projections.values.title, 'Still live')
assert.equal(plugin.store.busyId, null)

responses.set(
  JSON.stringify({ type: 'client-request', rpcId: 'xharness-tasks-5', method: 'session.fork', payload: { sessionId: 'x' } }),
  { result: { ok: false, error: { message: 'fork denied' } } },
)
await plugin.store.fork('x')
assert.equal(plugin.store.actionError, 'fork denied')
assert.equal(plugin.store.busyId, null)

// Exit animation completion owns unmount; reopening invalidates stale timers.
plugin.store.open = true
plugin.store.setOpen(false)
assert.equal(plugin.store.closing, true)
const slotRegistrations = []
plugin.apply({
  effect() {},
  locale: { register() {} },
  slots: {
    inject(_name, register) { register() },
    register(_options, component) { slotRegistrations.push(component) },
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
const closingPanel = findClass(React.createElement(slotRegistrations[0]), 'xhtask-panel-wrap-closing')
assert.ok(closingPanel)
const ownTarget = {}
closingPanel.props.onAnimationEnd({ target: {}, currentTarget: ownTarget, animationName: 'xhtask-panel-out' })
assert.equal(plugin.store.closing, true, 'nested animation cannot unmount the panel')
closingPanel.props.onAnimationEnd({ target: ownTarget, currentTarget: ownTarget, animationName: 'xhtask-panel-in' })
assert.equal(plugin.store.closing, true, 'entry animation cannot unmount the panel')
closingPanel.props.onAnimationEnd({ target: ownTarget, currentTarget: ownTarget, animationName: 'xhtask-panel-out' })
assert.equal(plugin.store.open, false)
assert.equal(closeTimers.size, 0)
const originalRefresh = plugin.store.refresh
plugin.store.refresh = async () => {}
plugin.store.setOpen(true)
plugin.store.setOpen(false)
const staleClose = closeTimers.get(plugin.store.closeTimer)
plugin.store.setOpen(true)
staleClose()
assert.equal(plugin.store.open, true)
assert.equal(plugin.store.closing, false)
reducedMotion = true
plugin.store.setOpen(false)
assert.equal(plugin.store.open, false, 'reduced motion closes immediately')
assert.equal(closeTimers.size, 0)
reducedMotion = false
plugin.store.setOpen(true)
plugin.store.setOpen(false)
closeTimers.get(plugin.store.closeTimer)()
assert.equal(plugin.store.open, false, 'watchdog prevents a stuck panel')
plugin.store.refresh = originalRefresh

console.log('tasks plugin: assertions passed')
