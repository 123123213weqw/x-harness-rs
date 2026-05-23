import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const sourceUrl = new URL('../ui/plugins/@xlang/xharness-client-ui-computer/client.js', import.meta.url)
const shippedUrl = new URL('../ui/dist/plugins/@xlang/xharness-client-ui-computer/client.js', import.meta.url)
const source = readFileSync(sourceUrl, 'utf8')
const shipped = readFileSync(shippedUrl, 'utf8')
assert.equal(shipped, source, 'shipped Computer UI must match its product source')

let registration
const sandbox = { window: { __ModuleLoader__: { load(value) { registration = value } } } }
vm.createContext(sandbox)
vm.runInContext(source, sandbox)
assert.equal(registration.id, '@xlang/xharness-client-ui-computer')

const React = {
  createElement() {},
  useEffect() {},
  useMemo(fn) { return fn() },
  useState(value) { return [value, () => {}] },
}
const plugin = registration.factory(id => {
  if (id === 'react') return React
  throw new Error(`unexpected module dependency: ${id}`)
})
assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ['slots', 'locale'])

const dictionary = {
  observeScreen: 'view', observeStructure: 'structure', observe: 'observe', semantic: 'semantic',
  window: 'window', windowAction: 'window-action', wait: 'wait', waitAction: 'wait-action',
  control: 'control', preparing: 'preparing', unknown: 'unknown', click: 'click',
  nodes: '{count} controls', windows: '{count} windows', screenshot: 'screenshot',
}
const t = (key, values = {}) => (dictionary[key] ?? key).replace('{count}', String(values.count ?? ''))
assert.deepEqual(
  JSON.parse(JSON.stringify(plugin.actionDescriptor({ action: 'observe', detail: 'semantic' }, t))),
  { action: 'observe', mode: 'view', activity: 'structure', summary: 'semantic' },
)
assert.equal(plugin.actionDescriptor({ action: 'click' }, t).mode, 'control')
assert.equal(plugin.settledState({ argsRaw: '{}' }), 'running')
assert.equal(plugin.settledState({ kind: 'tool-result', isError: true }), 'error')
assert.equal(plugin.resultSummary({ accessibility: { nodes: [{}, {}] }, surfaces: [{}], screenshot_included: true }, { action: 'observe', summary: 'observe' }, t), '2 controls · 1 windows · screenshot')

let row
let localeRegistration
const ctx = {
  effect(run) { run() },
  locale: { register(namespace, dictionaries) { localeRegistration = { namespace, dictionaries } } },
  slots: {
    inject(name, run) { assert.equal(name, 'tool.call.toolview'); run() },
    register(config, component) { assert.equal(config.key, 'computer'); row = component },
  },
}
plugin.apply(ctx)
assert.equal(typeof row, 'function')
assert.equal(localeRegistration.namespace, 'xharness-computer')
assert.match(localeRegistration.dictionaries.zh.observeScreen, /查看屏幕/)
assert.match(source, /desktop_set_computer_activity/)
assert.match(source, /nativeTail/)

const graph = JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json', import.meta.url), 'utf8'))
const entry = graph.entries.find(candidate => candidate.id === registration.id)
assert.ok(entry, 'shipped graph must load the Computer UI')
assert.ok(entry.inject.includes('@xharness/dsh-client-ui-tool'))
console.log('computer UI source, registration, summaries, privacy copy and shipped graph passed')
