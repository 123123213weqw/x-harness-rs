import { assertRebuildInput } from './fixtures/repository-ui-input.mjs'
const registrationId = '@xlang/xharness-client-ui-terminal'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let registration
const sourcePath = new URL('../ui/dist/plugins/@xlang/xharness-client-ui-terminal/client.js', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const shipped = await readFile(
  new URL('../ui/dist/plugins/@xlang/xharness-client-ui-terminal/client.js', import.meta.url),
  'utf8',
)
assertRebuildInput(registrationId)
const graph = JSON.parse(await readFile(new URL('../ui/dist/client-graph.json', import.meta.url), 'utf8'))
const terminalEntry = graph.entries.find((entry) => entry.id === '@xlang/xharness-client-ui-terminal')
assert.ok(terminalEntry)
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16)
assert.equal(terminalEntry.rev, hash(source))
assert.equal(graph.rev, hash(JSON.stringify(graph.entries)))
const index = await readFile(new URL('../ui/dist/index.html', import.meta.url), 'utf8')
assert.ok(index.includes(`window.__DSH_BOOT__ = ${JSON.stringify(graph)}`))

const sandbox = {
  atob: globalThis.atob,
  window: {
    localStorage: {
      getItem() { return null },
      setItem() {},
    },
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  },
}
let reducedMotion = false
let panelExitToken = ''
let closeDelay = 0
let nextCloseTimer = 0
const closeTimers = new Map()
sandbox.window.matchMedia = () => ({ matches: reducedMotion })
sandbox.window.getComputedStyle = () => ({ getPropertyValue: () => panelExitToken })
sandbox.window.setTimeout = (callback, delay) => {
  closeDelay = delay
  const id = ++nextCloseTimer
  closeTimers.set(id, callback)
  return id
}
sandbox.window.clearTimeout = (id) => closeTimers.delete(id)
const pendingSleeps = []
sandbox.setTimeout = (callback) => { pendingSleeps.push(callback); return pendingSleeps.length }
const keydownListeners = new Set()
sandbox.window.addEventListener = (event, listener) => {
  if (event === 'keydown') keydownListeners.add(listener)
}
sandbox.window.removeEventListener = (event, listener) => {
  if (event === 'keydown') keydownListeners.delete(listener)
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const effects = []
const React = {
  createElement(type, props, ...children) { return { type, props, children } },
  Fragment: 'fragment',
  useEffect(effect) { effects.push(effect) },
  useRef() { return { current: null } },
  useState(value) { return [value, () => {}] },
}
let documentState = { lang: 'zh-CN' }
sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' })
sandbox.document = {
  get documentElement() { return { get lang() { return documentState.lang }, style: {} } },
  createElement(tag) {
    return {
      tag,
      style: {},
      children: [],
      append(...nodes) { this.children.push(...nodes) },
      remove() {},
      getContext() { return null },
    }
  },
  get body() { return this.createElement('body') },
  addEventListener() {},
  removeEventListener() {},
}

let fetchResponse = null
const fetchCalls = []
sandbox.fetch = async (url, options) => {
  fetchCalls.push({ url, body: JSON.parse(options.body) })
  if (fetchResponse === null) throw new Error('fetch stub not configured')
  return fetchResponse
}

const plugin = registration.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected module dependency: ${id}`)
})

assert.equal(registration.id, '@xlang/xharness-client-ui-terminal')
// deepStrictEqual compares prototypes across the vm realm boundary, so the
// injected service list is compared via JSON instead.
assert.equal(JSON.stringify(plugin.inject), '["slots","locale"]')
assert.equal(typeof plugin.apply, 'function')
const slotRegistrations = []
plugin.apply({
  effect() {},
  slots: {
    inject(name, register) { slotRegistrations.push({ name, registration: register() }) },
    register(options, component) { return { options, component } },
  },
})
assert.equal(
  JSON.stringify(slotRegistrations.map(({ name }) => name)),
  JSON.stringify(['conversation.session.header.actions', 'conversation.input.dock']),
)
assert.equal(slotRegistrations[1].registration.options.id, 'xharness-terminal-dock')
assert.equal(slotRegistrations[1].registration.options.order, 20)
for (const { registration: { options } } of slotRegistrations) {
  assert.equal(options.inject('chat-a').sessionId, 'chat-a')
}
const storeA = plugin.getDockStore('chat-a')
const storeB = plugin.getDockStore('chat-b')
assert.notEqual(storeA, storeB, 'a new conversation must not inherit another terminal dock')
assert.equal(plugin.getDockStore('chat-a'), storeA)
assert.equal(plugin.getDockStore(undefined), null)
assert.match(source, /\.xhterm-dock\{order:1;display:flex/)
assert.doesNotMatch(source, /\.xhterm-dock\{position:fixed/)
assert.match(source, /\.xhterm-viewport \.xterm-viewport\{overscroll-behavior-y:contain\}/)

// Browser shortcuts consume stable markers, never localized titles.
const triggerRoot = slotRegistrations[0].registration.component({ sessionId: 'chat-a' })
const trigger = () => triggerRoot.type(triggerRoot.props)
for (const lang of ['zh-CN', 'en']) {
  documentState.lang = lang
  for (const [open, closing, expected] of [[false, false, 'false'], [true, false, 'true'], [true, true, 'false']]) {
    storeA.open = open; storeA.closing = closing
    const element = trigger()
    assert.equal(element.type, 'button')
    assert.equal(element.props['data-xh-terminal-trigger'], '')
    assert.equal(element.props['data-xh-terminal-open'], expected)
    assert.equal(element.props.title, lang === 'zh-CN' ? (open ? '关闭终端' : '终端') : (open ? 'Close terminal' : 'Terminal'))
  }
}
storeA.open = false; storeA.closing = false
// The rendered height must track the store even while a drag is in progress.
storeA.open = true
assert.equal(storeB.open, false, 'opening chat A must leave chat B closed')
storeA.setHeight(320)
const dockRoot = slotRegistrations[1].registration.component({ sessionId: 'chat-a' })
const dock = dockRoot.type(dockRoot.props)
assert.equal(dock.props.style.height, 320)
storeA.setHeight(90)
assert.equal(dockRoot.type(dockRoot.props).props.style.height, 160)
storeA.open = false

// CSS animation completion, not a parallel 190ms timer, owns unmount.
storeA.open = true
storeA.setOpen(false)
assert.equal(storeA.closing, true)
assert.equal(closeDelay, 1000, 'the default close watchdog keeps a one-second minimum')
const closingDock = dockRoot.type(dockRoot.props)
const ownTarget = {}
closingDock.props.onAnimationEnd({ target: {}, currentTarget: ownTarget, animationName: 'xhterm-dock-out' })
assert.equal(storeA.closing, true, 'child animations cannot close the dock')
closingDock.props.onAnimationEnd({ target: ownTarget, currentTarget: ownTarget, animationName: 'xhterm-dock-in' })
assert.equal(storeA.closing, true, 'entry animation cannot close the dock')
closingDock.props.onAnimationEnd({ target: ownTarget, currentTarget: ownTarget, animationName: 'xhterm-dock-out' })
assert.equal(storeA.open, false)
assert.equal(storeA.closing, false)
assert.equal(closeTimers.size, 0)

const originalRefresh = storeA.refresh
storeA.refresh = async () => {}
storeA.setOpen(true)
storeA.setOpen(false)
const staleClose = closeTimers.get(storeA.closeTimer)
storeA.setOpen(true)
staleClose()
assert.equal(storeA.open, true, 'stale completion after reopen is ignored')
assert.equal(storeA.closing, false)
reducedMotion = true
storeA.setOpen(false)
assert.equal(storeA.open, false, 'reduced motion closes immediately')
assert.equal(closeTimers.size, 0)
reducedMotion = false
storeA.setOpen(true)
storeA.setOpen(false)
closeTimers.get(storeA.closeTimer)()
assert.equal(storeA.open, false, 'watchdog handles missing animationend')
panelExitToken = '2s'
storeA.setOpen(true)
storeA.setOpen(false)
assert.equal(closeDelay, 2500, 'the watchdog follows longer CSS motion tokens')
closingDock.props.onAnimationEnd({ target: ownTarget, currentTarget: ownTarget, animationName: 'xhterm-dock-out' })
assert.equal(closeTimers.size, 0, 'animation completion cancels the extended watchdog')
panelExitToken = '1350ms'
storeA.setOpen(true)
storeA.setOpen(false)
assert.equal(closeDelay, 1850, 'millisecond tokens also extend the watchdog')
storeA.finishClose()
panelExitToken = ''
storeA.refresh = originalRefresh

// The exit notice follows the document language and carries exit details.
documentState.lang = 'zh-CN'
assert.match(plugin.exitNotice({ exitCode: 3, exitSignal: null }), /进程已退出，退出码 3/)
documentState.lang = 'en'
assert.match(plugin.exitNotice({ exitCode: null, exitSignal: 9 }), /process exited, signal 9/)
assert.match(plugin.exitNotice({}), /process exited\]/)

// terminalCall surfaces structured failures from the extension routes.
fetchResponse = {
  ok: false,
  status: 409,
  json: async () => ({ ok: false, error: { code: 'terminal_error', message: 'boom' } }),
}
await assert.rejects(() => plugin.terminalCall('open', { name: 'x' }), /boom/)
fetchResponse = { ok: true, status: 200, json: async () => ({ ok: true, terminal: {} }) }
await assert.rejects(() => plugin.terminalCall('open', { name: 'x' }), /Invalid terminal descriptor/)
fetchResponse = { ok: true, status: 200, json: async () => ({ ok: true, terminal: { name: 'x', running: true } }) }
assert.deepEqual(JSON.parse(JSON.stringify(await plugin.terminalCall('open', { name: 'x' }))), { ok: true, terminal: { name: 'x', running: true } })

// The theme resolver degrades to provided fallbacks without a canvas context.
documentState.lang = 'zh-CN'
const theme = plugin.terminalTheme()
assert.equal(theme.background, '#1e1e1e')
assert.equal(theme.foreground, '#d4d4d4')

// A fresh tab starts attached at the scrollback base with no exit recorded.
const tab = new plugin.TerminalTab('t1', { running: true }, storeA)
assert.equal(tab.cursor, 0)
assert.equal(tab.running, true)
assert.equal(tab.exitedNotified, false)
assert.equal(storeA.open, false)
assert.ok(Number.isFinite(storeA.height))

// UTF-8 fragments must reach xterm as bytes, not as independently decoded
// strings that replace a split code point with U+FFFD.
const written = []
tab.ensureTerm = async () => ({ write(chunk) { written.push(Array.from(chunk)) } })
tab.pollLoop = () => {}
fetchResponse = {
  ok: true,
  status: 200,
  json: async () => ({ ok: true, read: {
    cursor: 1, running: true, content_base64: '5g==', truncated_before_cursor: false,
  } }),
}
await tab.attach()
assert.equal(fetchCalls.at(-1).body.session_id, 'chat-a')
fetchResponse = {
  ok: true,
  status: 200,
  json: async () => ({ ok: true, read: {
    cursor: 3, running: true, content_base64: 'sYk=', truncated_before_cursor: false,
  } }),
}
await tab.attach()
assert.deepEqual(written, [[0xe6], [0xb1, 0x89]])
assert.equal(tab.cursor, 3)
tab.container = { remove() {} }
tab.term = { dispose() {} }
storeA.tabs.push(tab)
storeA.suspend()
assert.equal(tab.cursor, 0, 'a hidden conversation must replay bounded scrollback')
assert.equal(tab.container, null, 'a hidden conversation must release the xterm DOM')
assert.equal(tab.term, null, 'a hidden conversation must release the xterm canvas')

// Hiding the dock invalidates a pending poll before it issues another read.
const sleepingTab = new plugin.TerminalTab('t2', { running: true }, storeA)
const poll = sleepingTab.pollLoop(sleepingTab.generation)
sleepingTab.stopPolling()
pendingSleeps.shift()()
await poll

// The wire calls and local tab lists are both scoped to the selected chat.
fetchResponse = { ok: true, status: 200, json: async () => ({ ok: true, terminal: { name: 't1', running: true } }) }
await storeB.create()
assert.equal(fetchCalls.at(-1).url, '/api/terminal/open')
assert.equal(fetchCalls.at(-1).body.session_id, 'chat-b')
assert.equal(storeB.tabs[0].name, 't1')
assert.equal(storeA.tabs[0].name, 't1', 'same tab name is valid in another chat')
fetchResponse = { ok: true, status: 200, json: async () => ({ ok: true, read: {} }) }
await storeB.close('t1')
assert.equal(fetchCalls.at(-1).url, '/api/terminal/close')
assert.equal(fetchCalls.at(-1).body.session_id, 'chat-b')
assert.equal(storeB.tabs.length, 0)
assert.equal(storeA.tabs.length, 1, 'closing chat B must not remove chat A')

// Shortcut ownership follows the mounted chat; cleanup must detach the old
// listener and dispose its xterm renderer without closing the server PTY.
storeA.refresh = async () => {}
effects.length = 0
slotRegistrations[1].registration.component({ sessionId: 'chat-a' })
assert.equal(effects.length, 1)
const leaveChatA = effects.pop()()
assert.equal(keydownListeners.size, 1)
storeA.open = false
for (const listener of keydownListeners) listener({ metaKey: true, key: '`', preventDefault() {} })
assert.equal(storeA.open, true)
assert.equal(storeB.open, false)
leaveChatA()
assert.equal(keydownListeners.size, 0)
effects.length = 0
slotRegistrations[1].registration.component({ sessionId: 'chat-b' })
const leaveChatB = effects.pop()()
assert.equal(keydownListeners.size, 1)
for (const listener of keydownListeners) listener({ metaKey: true, key: '`', preventDefault() {} })
assert.equal(storeB.open, true)
leaveChatB()
assert.equal(keydownListeners.size, 0)

console.log('terminal plugin: assertions passed')
