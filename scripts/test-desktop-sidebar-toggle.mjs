// The real source-owned sidebar keeps its original layout action; only the
// physical DOM seat changes on macOS. No native command or layout store clone.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { compileSourceModules } from './build-source-modules.mjs'
import { exposeModuleUnit } from './fixtures/module-unit-scope.mjs'
import { testHooks, descendants } from './conversation-test-hooks.mjs'

const id = '@xharness/dsh-client-ui-sidebar'
const compiled = compileSourceModules(new URL('../ui', import.meta.url).pathname, [{ id, source: 'src/modules/sidebar/index.ts' }]).get(id).bytes.toString()
const shipped = readFileSync(new URL(`../ui/dist/plugins/${id}/client.js`, import.meta.url), 'utf8')
assert.equal(compiled === shipped, true, 'sidebar shipped bundle must come from current source')
const source = exposeModuleUnit(compiled, 'sidebar', 'SidebarRoot', 'SidebarRoot')

function mount({ native = true, ready = true, collapsed = false } = {}) {
  const hooks = testHooks(), effects = [], listeners = new Map(), cleanups = []
  let host = ready ? { id: 'xh-desktop-titlebar-controls' } : null
  let toggles = 0
  const document = {
    documentElement: { dataset: native ? { xhMacTitlebar: 'overlay' } : {} },
    getElementById: id => id === 'xh-desktop-titlebar-controls' ? host : null,
    querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} },
  }
  const window = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) },
    setTimeout: () => 1, clearTimeout() {},
    __ModuleLoader__: { load: row => { registration = row } },
  }
  let registration
  vm.runInNewContext(source, { document, window })
  const react = { ...hooks.react, useEffect: fn => effects.push(fn) }
  const plugin = registration.factory(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return hooks.jsx
    if (name === 'react-dom') return { createPortal: (children, container) => ({ type: 'portal', props: { children, container } }) }
    if (name === '@xharness/dsh-client-ui-primitives') return new Proxy({}, { get: (_target, key) => String(key) })
    if (name === '@xharness/cordis') return {}
    throw Error(`unexpected dependency ${name}`)
  })
  const t = key => ({ 'toggle.open': 'Open sidebar', 'toggle.collapse': 'Collapse sidebar' })[key] ?? key
  const render = () => hooks.render(() => plugin.SidebarRoot({ collapsed, width: 280, startSession() {}, toggleSidebar: () => { toggles++ }, t, renderSlot: () => null }))
  const flush = () => { for (const effect of effects.splice(0)) { const off = effect(); if (typeof off === 'function') cleanups.push(off) } }
  return { render, flush, listeners, get toggles() { return toggles }, get host() { return host },
    ready: () => { host = { id: 'xh-desktop-titlebar-controls' }; listeners.get('xh-desktop-titlebar-ready')?.() },
    close: () => cleanups.forEach(fn => fn()) }
}
const toggles = tree => descendants(tree, n => n.type === 'button' && /^(Open|Collapse) sidebar$/.test(n.props['aria-label'] ?? ''))

test('macOS expanded/collapsed use exactly one accessible titlebar control and the existing action', () => {
  for (const collapsed of [true, false]) {
    const page = mount({ collapsed }), tree = page.render(), buttons = toggles(tree)
    assert.equal(buttons.length, 1)
    const portals = descendants(tree, n => n.type === 'portal')
    assert.equal(portals.length, 1)
    assert.equal(portals[0].props.container, page.host)
    assert.equal(toggles(portals[0])[0], buttons[0], 'the old brand-row toggle is removed, not duplicated')
    assert.equal(buttons[0].props['aria-expanded'], !collapsed)
    assert.equal(buttons[0].props.type, 'button')
    assert.equal(buttons[0].props['data-tauri-drag-region'], undefined)
    buttons[0].props.onClick()
    assert.equal(page.toggles, 1)
  }
})

test('browser and non-macOS native layouts retain the existing sidebar toggle even with an unrelated DOM seat', () => {
  for (const collapsed of [true, false]) {
    const page = mount({ native: false, collapsed }), tree = page.render()
    assert.equal(descendants(tree, n => n.type === 'portal').length, 0)
    assert.equal(toggles(tree).length, 1)
    toggles(tree)[0].props.onClick()
    assert.equal(page.toggles, 1)
  }
})

test('deferred titlebar mount relocates the fallback toggle and cleans up its listener on unmount', () => {
  const page = mount({ ready: false })
  assert.equal(descendants(page.render(), n => n.type === 'portal').length, 0)
  page.flush()
  assert.equal(page.listeners.size, 1)
  page.ready()
  const tree = page.render()
  assert.equal(descendants(tree, n => n.type === 'portal').length, 1)
  assert.equal(toggles(tree).length, 1)
  page.close()
  assert.equal(page.listeners.size, 0)
})
