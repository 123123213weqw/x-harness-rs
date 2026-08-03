// Product source migration acceptance. Compare the retained pre-migration
// implementation to compiler-checked source; never edit either implementation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileSourceModules } from './build-source-modules.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const allNames = ['plugin-hub', 'profile', 'motion', 'directory', 'computer', 'schedule', 'tasks', 'terminal', 'context']
const names = process.env.UI_TEST_PRODUCT_MODULES ? allNames.filter(name => process.env.UI_TEST_PRODUCT_MODULES.split(',').includes(name)) : allNames
if (!names.length) throw Error('No product source modules selected')
const idOf = name => `@xlang/xharness-client-ui-${name}`
const rows = names.map(name => ({ id: idOf(name), source: `src/modules/${name}/index.${name === 'motion' ? 'ts' : 'tsx'}` }))
const compiled = compileSourceModules(join(repo, 'ui'), rows)
const normalized = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'function' ? `[function:${item.name}]` : item))
class ElementStub {
  constructor(tagName = 'div', parentElement = null) { this.tagName = tagName.toUpperCase(); this.parentElement = parentElement; this.children = []; this.attrs = new Map(); this.style = {setProperty() {}, removeProperty() {}}; this.isConnected = true; this.textContent = ''; this.id = ''; this.dataset = {} }
  append(...children) { this.children.push(...children) }
  appendChild(child) { this.append(child) }
  remove() { this.isConnected = false }
  contains(value) { return this === value || this.children.some(child => child.contains(value)) }
  closest(selector) { return this.attrs.has(selector) ? this : this.parentElement?.closest(selector) ?? null }
  setAttribute(key, value) { this.attrs.set(key, value) }
  removeAttribute(key) { this.attrs.delete(key) }
  hasAttribute(key) { return this.attrs.has(key) }
  querySelector() { return null }
  querySelectorAll() { return [] }
}
function harness(source, name, options = {}) {
  const effects = []; const cleanups = []; const slots = []; const locales = []; const definitions = []; const views = []
  const styles = new Map(); const timeouts = new Map(); const storage = new Map(Object.entries(options.storage ?? {})); const requests = []; const events = new Map()
  const body = new ElementStub(); const head = new ElementStub()
  head.append = node => { head.children.push(node); if (node.id) styles.set(node.id, node) }
  const document = { body, head, documentElement: {lang: 'en'}, getElementById: id => styles.get(id) ?? null, querySelector: () => null,
    querySelectorAll: () => [], createElement: tag => new ElementStub(tag) }
  const window = {localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)}, matchMedia: () => ({matches: options.reduced === true}), getComputedStyle: () => ({getPropertyValue: () => ''}),
    addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name),
    setTimeout: (callback, delay) => {const id = timeouts.size + 1; timeouts.set(id, {callback, delay}); return id}, clearTimeout: id => timeouts.delete(id), confirm: () => true,
    __ModuleLoader__: {load: row => {registration = row}}}
  const react = options.react ?? {createElement: (type, props, ...children) => ({type, props: props ?? {}, children}), Fragment: 'Fragment',
    useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: value => ({current: value}), useId: () => 'automation-test-panel',
    useEffect: effect => effects.push(effect), useMemo: callback => callback(), useSyncExternalStore: (_subscribe, snapshot) => snapshot()}
  const api = {createPluginClient: () => (method, params) => {requests.push({method, params}); return Promise.resolve({})}, errorMessage: error => error?.message ?? String(error), isUnsupportedEndpoint: () => false}
  const primitives = {Button: 'Button', Modal: 'Modal', IconFolderClose16: 'Folder', IconChevronRightOutline14: 'Right', IconChevronDownOutline14: 'Down', useAnchoredPosition: () => null}
  const jsx = (type, props, key) => react.createElement(type, {...props, ...(key === undefined ? {} : {key})}, props?.children)
  const externals = {react, 'react/jsx-runtime': {jsx, jsxs: jsx, Fragment: react.Fragment}, 'react-dom': {createPortal: value => value}, '@xharness/dsh-client-ui-primitives': primitives, '@xlang/xharness-client-plugin-api': api}
  const globals = {window, document, console, TextEncoder, AbortController, Element: ElementStub, HTMLElement: ElementStub, Node: ElementStub,
    MutationObserver: class {observe() {} disconnect() {}}, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, sessionStorage: window.localStorage,
    atob, Uint8Array, Date, Promise, setInterval: () => 1, clearInterval() {}, navigator: {clipboard: {writeText: async () => {}}}, ...options.globals}
  let registration
  const code = source ? compiled.get(idOf(name)).bytes.toString() : readFileSync(join(repo, `ui/reference/master-a613970/plugins/${idOf(name)}/client.js`), 'utf8')
  vm.runInNewContext(code, globals)
  assert.equal(registration.id, idOf(name))
  const plugin = registration.factory(request => {if (!(request in externals)) throw Error(`Unexpected external ${request}`); return externals[request]})
  const ctx = {effect: effect => {const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup)},
    locale: {register: (namespace, dictionaries) => locales.push({namespace, dictionaries}), bind: () => (key, values = {}) => `${key}:${Object.values(values).join(',')}`},
    slots: {inject: (_name, callback) => callback(), register: (spec, component) => slots.push({spec, component})},
    get: name => name === 'workCatalog' ? {subscribe: () => () => {}, getSnapshot: () => ({phase:'pending',loading:false,error:null,sessions:[],workspaces:[],archivedSessionIds:[],archivedSessions:[]})} : ({rpc: {send: async () => ({result: {ok: true, value: {}}})}}),
    workspaces: {listDirectory: async () => ({path: '', entries: [], crumbs: []}), createDirectory: async () => '/new'},
    sessions: {list: {subscribe: () => () => {}, getSnapshot: () => ({byId: {}})}},
    conversationEvents: {register: definition => definitions.push(definition)}, conversationViews: {register: definition => views.push(definition)}}
  return {plugin, ctx, slots, locales, definitions, views, styles, effects, cleanups, requests, timeouts, window, document, globals}
}
function treeText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(treeText).join('|')
  if (typeof node !== 'object') return String(node)
  return (node.children ?? []).map(treeText).join('|')
}

for (const name of names) {
  test(`${name}: strict source exports, inject, slots, locale and styles match existing product`, () => {
    const before = harness(false, name); const after = harness(true, name)
    assert.deepEqual(Object.keys(after.plugin).sort(), Object.keys(before.plugin).filter(key => name !== 'tasks' || key !== 'rpc').sort())
    const expectedInject = name === 'context' ? [...before.plugin.inject, 'locale']
      : ['tasks','schedule'].includes(name) ? [...before.plugin.inject,'workCatalog'] : before.plugin.inject
    assert.deepEqual(normalized(after.plugin.inject), normalized(expectedInject))
    before.plugin.apply(before.ctx); after.plugin.apply(after.ctx)
    if (name === 'context') {
      assert.equal(after.locales.length, 1)
      assert.equal(after.locales[0].namespace, 'xharness.harness')
      assert.deepEqual(Object.keys(after.locales[0].dictionaries.zh).sort(), Object.keys(after.locales[0].dictionaries.en).sort())
    } else {
      const expectedLocales = normalized(before.locales)
      if (name === 'tasks') for (const dictionary of Object.values(expectedLocales[0].dictionaries)) { delete dictionary['panel.open']; delete dictionary['panel.close'] }
      if (name === 'plugin-hub') {
        // Native consent deliberately adds two in-page dialog labels; every
        // existing dictionary entry must still match the frozen baseline.
        Object.assign(expectedLocales[0].dictionaries.zh, {cancel: '取消', close: '关闭'})
        Object.assign(expectedLocales[0].dictionaries.en, {cancel: 'Cancel', close: 'Close'})
      }
      assert.deepEqual(normalized(after.locales), expectedLocales)
    }
    const expectedSlots = normalized(before.slots.filter(row => name !== 'context' || row.spec.id !== 'context').map(row => name === 'context' && row.spec.id === 'harness' ? {...row.spec, inject: () => {}} : row.spec))
    if (name === 'tasks') expectedSlots[0].name = 'work.center.tasks'
    if (name === 'schedule') expectedSlots.unshift({name: 'work.center.automations', id: 'automations', order: 20})
    assert.deepEqual(normalized(after.slots.map(row => row.spec)), expectedSlots)
    if (name === 'context') {
      const current = after.styles.get('xharness-context-inspector-style').textContent
      // Context is intentionally removed; Harness retains the shared scroll
      // contract and theme tokens, without obsolete colored diagnostic styles.
      assert.deepEqual(after.slots.map(row => row.spec.id), ['harness'])
      assert.doesNotMatch(current, /xhctx-card|xhctx-filterbar|xhctx-compaction-banner|xhctx-diff/)
      assert.match(current, /background:var\(--dsw-alias-bg-base,#fff\)/)
      assert.doesNotMatch(current, /xhctx-pipeline|xhctx-assembly-section|xhctx-harness-columns/)
    } else {
      const expectedStyles = [...before.styles].map(([id, style]) => [id, style.textContent])
      if (name === 'plugin-hub') {
        // Keep the immutable migration baseline intact. Preserve every original
        // rule; allow only these explicit passive-image and consent extensions.
        assert.equal(expectedStyles.length, 1)
        assert.equal(expectedStyles[0][0], 'xharness-plugin-hub-style')
        expectedStyles[0][1] += '.xhph-icon-artwork{background:transparent}.xhph-icon img{display:block;width:42px;height:42px;object-fit:contain}\n'
        expectedStyles[0][1] += '.xhph-confirm-message{white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto;font-size:13px;line-height:1.6}.xhph-confirm-actions{display:flex;justify-content:flex-end;gap:10px}\n'
      }
      if (name === 'tasks') expectedStyles[0][1] = expectedStyles[0][1].slice(expectedStyles[0][1].indexOf('.xhtask-panel{'))
      if (name === 'schedule') expectedStyles.push(['xharness-automation-navigation-style', readFileSync(join(repo, 'ui/src/modules/schedule/AutomationNavigation.css'), 'utf8')])
      assert.deepEqual([...after.styles].map(([id, style]) => [id, style.textContent]), expectedStyles)
    }
    for (const cleanup of after.cleanups) cleanup()
  })
}

test('profile: normal/malformed usage, cached tokens and 26-week windows preserve results', () => {
  const old = harness(false, 'profile').plugin; const current = harness(true, 'profile').plugin
  const midnight = Date.UTC(2026, 9, 1)
  const sample = {dayStartMs: midnight, uncachedInputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40, outputTokens: 5}
  const rows = [{id: 'a', projectionValues: {dailyTokenUsage: [sample, {...sample, dayStartMs: midnight + 1}, {...sample, outputTokens: -5}]}}, {id: 'b', blank: true}, {id: 'c'}, null]
  for (const api of [old, current]) {
    const usage = api.summarize(rows)
    assert.equal(usage.total, 725)
    assert.equal(usage.chats, 2)
    assert.equal(usage.measured, 1)
    assert.equal(usage.daily.get('2026-10-01'), 725)
    const calendar = api.calendar(new Date(midnight)); assert.equal(calendar.length, 26); assert.equal(calendar.flat().length, 182)
  }
  assert.deepEqual(normalized(current.summarize(rows)), normalized(old.summarize(rows)))
  assert.deepEqual(normalized(current.calendar(new Date(midnight), 3)), normalized(old.calendar(new Date(midnight), 3)))
})

test('motion: fake-element pure planner preserves deduplication, churn and stagger', () => {
  const row = new ElementStub(); const parent = new ElementStub('div', row); row.append(parent)
  const nodes = ['p', 'p', 'pre', 'li'].map(tag => new ElementStub(tag, parent)); parent.append(...nodes)
  const child = new ElementStub('p', nodes[3]); nodes[3].append(child)
  const apis = [harness(false, 'motion').plugin, harness(true, 'motion').plugin]
  for (const api of apis) {
    const recent = new WeakMap()
    const planned = api.planStreamAnimations([null, undefined, {}, 42, false, ...nodes, child], row, 10000, recent)
    assert.deepEqual(Array.from(planned, item => item.delayMs), [0, 45, 90, 135])
    // Preserve the current cross-batch rule: the first shared-parent hit is
    // suppressed; the remaining siblings are kept. This is an existing
    // planner limitation, not a migration regression.
    assert.equal(api.planStreamAnimations(nodes, row, 10001, recent).length, 3)
    assert.equal(api.planStreamAnimations(nodes, row, 11000, recent).length, 4)
    assert.equal(api.planStreamAnimations(nodes, null, 12000, recent).length, 0)
  }
})

test('computer: all actions, observed summaries and settled states match', () => {
  const a = harness(false, 'computer').plugin; const b = harness(true, 'computer').plugin
  const t = (key, data = {}) => `${key}:${data.count ?? ''}`
  for (const action of ['', 'observe', 'window', 'wait', 'click', 'drag', 'scroll', 'type', 'keypress', 'move', 'unknown']) {
    for (const extra of [{}, {detail: 'semantic'}, {include_screenshot: false}, {operation: 'list'}]) {
      const args = {action, ...extra}; assert.deepEqual(normalized(b.actionDescriptor(args, t)), normalized(a.actionDescriptor(args, t)))
    }
  }
  for (const block of [{}, {kind: 'tool-result'}, {kind: 'tool-result', isError: true}, {kind: 'tool-result', error: {code: 'interrupted'}}]) assert.equal(b.settledState(block), a.settledState(block))
  const value = {action: 'observe', accessibility: {nodes: [{}, {}]}, surfaces: [{}], screenshot_included: true}
  assert.equal(b.resultSummary(value, {action: 'observe', summary: ''}, t), a.resultSummary(value, {action: 'observe', summary: ''}, t))
})

test('schedule: create/delete/dispatch folding, interval jumps and read-only projection preserve values', () => {
  const old = harness(false, 'schedule').plugin; const current = harness(true, 'schedule').plugin
  const record = {id: 'a', kind: 'every', prompt: 'repeat', everySeconds: 60, scheduledAt: '2026-10-01T00:00:00Z'}
  const histories = [[], [{operation: 'create', schedule: record}], [{operation: 'create', schedule: record}, {operation: 'dispatch', id: 'a', acceptedAt: '2026-10-01T00:05:00Z'}], [{operation: 'create', schedule: record}, {operation: 'delete', id: 'a'}], [null, {}, {operation: 'create', schedule: null}]]
  const t = (key, data) => `${key}:${JSON.stringify(data)}`
  for (const history of histories) assert.deepEqual(normalized(current.foldScheduleChanges(history)), normalized(old.foldScheduleChanges(history)))
  for (const api of [old, current]) {assert.deepEqual(normalized(api.scheduleRecords([], [record])), []); assert.equal(api.orderScheduleRecords([record], Date.now())[0].id, 'a')}
  for (const seconds of [1, 5, 60, 3600, 86400]) assert.equal(current.formatScheduleFrequency({...record, everySeconds: seconds}, t), old.formatScheduleFrequency({...record, everySeconds: seconds}, t))
})

test('tasks: grouping, pinning and archive labels preserve behavior; page has no drawer state', () => {
  const old = harness(false, 'tasks'); const current = harness(true, 'tasks')
  const rows = [{sessionId: 'a', updatedAt: Date.now(), projections: {values: {title: 'A'}}}, {sessionId: 'b', updatedAt: 0, cwd: '/a/b'}, {sessionId: 'blank', blank: true}]
  assert.deepEqual(normalized(current.plugin.groupSessions(rows, ['b'], Date.now())), normalized(old.plugin.groupSessions(rows, ['b'], Date.now())))
  for (const value of [0, -10, null, 'bad', 1700000000, 1700000000000]) assert.equal(current.plugin.normalizeTimestamp(value), old.plugin.normalizeTimestamp(value))
  const t = key => key
  for (const row of rows) assert.equal(current.plugin.sessionTitle(row, t), old.plugin.sessionTitle(row, t))
  for (const host of [old, current]) {
    const state = host.plugin.store; state.togglePinned('a'); state.togglePinned('b'); state.togglePinned('a'); assert.deepEqual(normalized(state.pinned), ['b'])
    state.snapshot(rows[0], t); assert.equal(state.snapshots.a.title, 'A')
    if (host === old) {
      state.open = true; state.setOpen(false); state.finishClose(); assert.equal(state.open, false)
    } else {
      for (const key of ['open', 'closing', 'closeTimer', 'setOpen', 'finishClose']) assert.equal(key in state, false, `removed drawer field ${key}`)
      assert.equal(host.timeouts.size, 0, 'Tasks does not start drawer timers')
    }
  }
})

test('terminal: bounded byte transport, per-chat store and close/reopen preserve behavior', () => {
  const old = harness(false, 'terminal'); const current = harness(true, 'terminal')
  for (const host of [old, current]) {
    const api = host.plugin; assert.deepEqual(Array.from(api.terminalBytes({content_base64: '5rGJ'})), [0xe6, 0xb1, 0x89])
    const a = api.getDockStore('a'), b = api.getDockStore('b'); assert.equal(api.getDockStore('a'), a); assert.notEqual(a, b)
    a.open = true; a.setHeight(9999); assert.equal(a.height, 640); a.setOpen(false); assert.equal(a.closing, true)
    a.finishClose(); assert.equal(a.open, false); assert.equal(b.open, false)
    const tab = new api.TerminalTab('t1', {running: true}, a); assert.equal(tab.cursor, 0); tab.dispose(); assert.equal(tab.container, null)
  }
})

test('terminal: stable shortcut markers preserve both languages and closing phase', () => {
  for (const host of [harness(false, 'terminal'), harness(true, 'terminal')]) {
    host.plugin.apply(host.ctx)
    const action = host.slots.find(({spec}) => spec.name === 'conversation.session.header.actions')
    const store = host.plugin.getDockStore('shortcut-seat')
    for (const lang of ['en', 'zh-CN']) {
      host.document.documentElement.lang = lang
      for (const [open, closing, expected] of [[false, false, 'false'], [true, false, 'true'], [true, true, 'false']]) {
        store.open = open; store.closing = closing
        const wrapper = action.component({sessionId:'shortcut-seat'})
        const trigger = wrapper.type(wrapper.props)
        assert.equal(trigger.type, 'button')
        assert.equal(trigger.props['data-xh-terminal-trigger'], '')
        assert.equal(trigger.props['data-xh-terminal-open'], expected)
        assert.equal(trigger.props.title, lang === 'zh-CN' ? (open ? '关闭终端' : '终端') : (open ? 'Close terminal' : 'Terminal'))
      }
    }
  }
})

test('context: request/usage/compaction projection is unchanged while Context UI is removed', {skip: !names.includes('context')}, () => {
  const hosts = [harness(false, 'context'), harness(true, 'context')]
  const output = []
  for (const host of hosts) {
    host.plugin.apply(host.ctx)
    const request = host.definitions.find(def => def.kind === 'xharness-context-request')
    const usage = host.definitions.find(def => def.kind === 'xharness-context-usage')
    const compact = host.definitions.find(def => def.kind === 'xharness-context-compaction')
    const location = {kind: 'step', turn: {turn: 2}, step: {step: 1}}
    const header = {config: {provider: 'deepseek', model: 'test'}, system: 'system', input: [{role: 'user', content: 'current request'}, {role: 'assistant', content: 'answer', reasoning: 'reason', toolCalls: [{id: '1', name: 'bash', argumentsJson: '{}'}]}, {role: 'tool', content: 'result', toolCallId: '1'}], tools: [{name: 'bash', description: 'shell', parameters: {}}], options: {step: 1, context: {policy: {name: 'identity', version: 1}}, tokenBudget: {accuracy: 'exact_request', estimate: {totalInputTokens: 50}, contextWindowTokens: 1000}}}
    const nodeFor = (definition, event, key) => definition.buildViewNode({key, kind: definition.kind, id: String(event.seq), state: definition.start({}, {event, location})})
    const nodes = [nodeFor(request, {type: 'request/header', seq: 1, time: 1, data: {header}}, 'r1'), nodeFor(usage, {seq: 2, data: {chunk: {kind: 'usage', usage: {input_tokens: 20, cache_read_tokens: 30}}}}, 'u1'), nodeFor(compact, {seq: 3, time: 3, data: {summary: 'summary', compactionId: 'c1'}}, 'c1')]
    const snapshot = host.views[0].create().replace({nodes})
    output.push(normalized(snapshot))
    assert.equal(snapshot.requests[0].usage.input_tokens, 20)
    assert.equal(snapshot.compactions[0].summary, 'summary')
    for (const {component} of host.slots) {
      const tree = component({sessionId: 'chat', useSession: fn => fn({views: new Map([['xharness-context', snapshot]])})})
      assert.equal(tree.props['data-conversation-composer-overlay'], '')
      assert.doesNotMatch(treeText(tree), /NaN|\[object Object\]/)
    }
  }
  assert.deepEqual(output[1], output[0])
})

test('strict source: malformed storage and terminal successes fail at typed boundaries', async () => {
  const current = harness(true, 'tasks', {storage: {'xharness.tasks.pinned.v1': '"not-an-array"', 'xharness.tasks.archive-snapshots.v1': '{"x":{"title":1}}'}})
  assert.deepEqual(normalized(current.plugin.store.pinned), [])
  assert.deepEqual(normalized(current.plugin.store.snapshots), {})
  const terminal = harness(true, 'terminal', {globals: {fetch: async () => ({ok: true, status: 200, json: async () => ({ok: true, terminal: {}})})}})
  await assert.rejects(terminal.plugin.terminalCall('open', {}), /Invalid terminal descriptor/)
})

function hooks() {
  const values = []; const pending = []; const cleanups = []; let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({type, props: props ?? {}, children}),
    useState(initial) {
      const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial
      return [values[index], next => {values[index] = typeof next === 'function' ? next(values[index]) : next}]
    },
    useRef(initial) {const index = cursor++; return values[index] ?? (values[index] = {current: initial})},
    useEffect(effect, deps) {
      const index = cursor++; const previous = values[index]
      if (!previous || !deps || deps.some((value, position) => !Object.is(value, previous[position]))) {values[index] = deps ?? []; pending.push(effect)}
    },
  }
  return {react, render(component, props) {cursor = 0; return component(props)}, runEffects() {while (pending.length) {const cleanup = pending.shift()(); if (typeof cleanup === 'function') cleanups.push(cleanup)}}, dispose() {for (const cleanup of cleanups) cleanup()}}
}
function findNode(tree, predicate) {
  if (Array.isArray(tree)) {for (const item of tree) {const match = findNode(item, predicate); if (match) return match} return undefined}
  if (!tree || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  return findNode(tree.children ?? [], predicate)
}
const settle = async () => {await Promise.resolve(); await Promise.resolve(); await Promise.resolve()}

for (const source of [false, true]) {
  test(`directory ${source ? 'source' : 'legacy'}: stale scan, cancel and unmounted replies cannot adopt a path`, async () => {
    const state = hooks(); const host = harness(source, 'directory', {react: state.react}); host.plugin.apply(host.ctx)
    const flow = host.slots[0].component
    const scans = []; const picked = []; let cancelled = 0
    const props = {open: true, busy: false, t: key => key, onPicked: path => picked.push(path), onCancel: () => {cancelled++},
      listDirectory: (path, signal) => new Promise((resolve, reject) => scans.push({path, signal, resolve, reject})), createDirectory: async () => '/created'}
    const dialog = flow(props); const render = () => state.render(dialog.type, dialog.props)
    let tree = render(); state.runEffects(); assert.equal(scans.length, 1)
    const pathInput = findNode(tree, node => node.type === 'input' && node.props['aria-label'] === 'path')
    pathInput.props.onChange({target: {value: '/chosen'}}); assert.equal(scans[0].signal.aborted, true)
    tree = render(); state.runEffects()
    findNode(tree, node => node.type === 'form' && node.props.className === 'xhdir-path').props.onSubmit({preventDefault() {}})
    assert.equal(scans.length, 2); assert.equal(scans[1].path, '/chosen')
    scans[0].resolve({path: '/stale', entries: [], crumbs: []}); await settle(); tree = render()
    assert.equal(findNode(tree, node => node.type === 'input' && node.props['aria-label'] === 'path').props.value, '/chosen')
    scans[1].resolve({path: '/chosen', entries: [], crumbs: []}); await settle(); tree = render()
    const cancel = findNode(tree, node => node.type === 'Button' && treeText(node) === 'cancel')
    assert.ok(cancel); cancel.props.onClick(); assert.equal(cancelled, 1); assert.deepEqual(picked, [])
    state.dispose(); scans[1].resolve({path: '/late', entries: [], crumbs: []}); await settle(); assert.deepEqual(picked, [])
  })
  test(`directory ${source ? 'source' : 'legacy'}: mkdir rejects path separators and uses Host-returned path once`, async () => {
    const state = hooks(); const host = harness(source, 'directory', {react: state.react}); host.plugin.apply(host.ctx)
    const scans = []; const mkdir = []; const picked = []
    const props = {open: true, busy: false, t: key => key, onPicked: path => picked.push(path), onCancel() {},
      listDirectory: async path => {scans.push(path); return {path: path === '' ? '/base' : path, entries: [], crumbs: []}},
      createDirectory: async (parent, name) => {mkdir.push({parent, name}); return '/host-returned-path'}}
    const dialog = host.slots[0].component(props); const render = () => state.render(dialog.type, dialog.props)
    let tree = render(); state.runEffects(); await settle(); tree = render()
    findNode(tree, node => node.type === 'button' && node.props.className === 'xhdir-new').props.onClick()
    tree = render(); state.runEffects()
    const form = () => findNode(tree, node => node.type === 'form' && node.props.className === 'xhdir-create')
    findNode(form(), node => node.type === 'input').props.onChange({target: {value: '../escape'}})
    tree = render(); await form().props.onSubmit({preventDefault() {}}); assert.deepEqual(mkdir, [])
    tree = render(); assert.ok(findNode(tree, node => node.props.role === 'alert'))
    findNode(form(), node => node.type === 'input').props.onChange({target: {value: 'new folder'}})
    tree = render(); await form().props.onSubmit({preventDefault() {}}); await settle(); tree = render()
    assert.deepEqual(mkdir, [{parent: '/base', name: 'new folder'}]); assert.equal(scans.at(-1), '/host-returned-path')
    const open = findNode(tree, node => node.type === 'Button' && treeText(node) === 'open'); assert.equal(open.props.disabled, false)
    open.props.onClick(); open.props.onClick(); assert.deepEqual(picked, ['/host-returned-path'])
    state.dispose()
  })
}
