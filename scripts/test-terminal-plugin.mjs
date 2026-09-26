import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let registration
const sourcePath = new URL('../ui/plugins/@xlang/xharness-client-ui-terminal/client.js', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const shipped = await readFile(
  new URL('../ui/dist/plugins/@xlang/xharness-client-ui-terminal/client.js', import.meta.url),
  'utf8',
)
assert.equal(shipped, source)
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
const pendingSleeps = []
sandbox.setTimeout = (callback) => { pendingSleeps.push(callback); return pendingSleeps.length }
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const React = {
  createElement(type, props, ...children) { return { type, props, children } },
  Fragment: 'fragment',
  useEffect() {},
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
sandbox.fetch = async () => {
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
assert.match(source, /\.xhterm-dock\{order:1;display:flex/)
assert.doesNotMatch(source, /\.xhterm-dock\{position:fixed/)

// The rendered height must track the store even while a drag is in progress.
plugin.dockStore.open = true
plugin.dockStore.setHeight(320)
const dockRoot = slotRegistrations[1].registration.component()
const dock = dockRoot.type(dockRoot.props)
assert.equal(dock.props.style.height, 320)
plugin.dockStore.setHeight(90)
assert.equal(dockRoot.type(dockRoot.props).props.style.height, 160)
plugin.dockStore.open = false

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
assert.deepEqual(await plugin.terminalCall('open', { name: 'x' }), { ok: true, terminal: {} })

// The theme resolver degrades to provided fallbacks without a canvas context.
documentState.lang = 'zh-CN'
const theme = plugin.terminalTheme()
assert.equal(theme.background, '#1e1e1e')
assert.equal(theme.foreground, '#d4d4d4')

// A fresh tab starts attached at the scrollback base with no exit recorded.
const tab = new plugin.TerminalTab('t1', { running: true })
assert.equal(tab.cursor, 0)
assert.equal(tab.running, true)
assert.equal(tab.exitedNotified, false)
assert.equal(plugin.dockStore.open, false)
assert.ok(Number.isFinite(plugin.dockStore.height))

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

// Hiding the dock invalidates a pending poll before it issues another read.
const sleepingTab = new plugin.TerminalTab('t2', { running: true })
const poll = sleepingTab.pollLoop(sleepingTab.generation)
sleepingTab.stopPolling()
pendingSleeps.shift()()
await poll

console.log('terminal plugin: assertions passed')
