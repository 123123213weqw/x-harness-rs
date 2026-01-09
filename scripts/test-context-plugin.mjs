#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const pluginPath = new URL(
  '../ui/plugins/@xlang/xharness-client-ui-context/client.js',
  import.meta.url,
)
const source = readFileSync(pluginPath, 'utf8')
let registration

const styleNodes = new Map()
const document = {
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  getElementById: id => styleNodes.get(id) ?? null,
  head: {
    append: node => { styleNodes.set(node.id, node) },
  },
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect: () => {},
  useMemo: fn => fn(),
  useState: initial => [initial, () => {}],
}

vm.runInNewContext(source, {
  TextEncoder,
  console,
  document,
  window: {
    __ModuleLoader__: {
      load: value => { registration = value },
    },
  },
})

assert.equal(registration.id, '@xlang/xharness-client-ui-context')
const client = registration.factory((id) => {
  if (id === 'react') return react
  throw new Error(`unexpected external ${id}`)
})
assert.deepEqual(
  [...client.inject],
  ['slots', 'conversationEvents', 'conversationViews', 'sessions'],
)

const eventDefinitions = []
const viewDefinitions = []
const tabs = []
const ctx = {
  effect: fn => {
    const dispose = fn()
    return () => { dispose?.() }
  },
  conversationEvents: {
    register: definition => { eventDefinitions.push(definition) },
  },
  conversationViews: {
    register: definition => { viewDefinitions.push(definition) },
  },
  slots: {
    inject: (_name, factory) => factory(),
    register: (options, component) => {
      tabs.push({ options, component })
      return () => {}
    },
  },
}
client.apply(ctx)

assert.equal(eventDefinitions.length, 2)
assert.equal(viewDefinitions.length, 1)
assert.equal(tabs.length, 2)
assert.equal(tabs[0].options.id, 'context')
assert.equal(tabs[0].options.order, 20)
assert.equal(tabs[1].options.id, 'harness')
assert.equal(tabs[1].options.order, 30)
const inspectorStyle = styleNodes.get('xharness-context-inspector-style')
assert.ok(inspectorStyle)
assert.doesNotMatch(inspectorStyle.textContent, /\.xhctx-budget/)
assert.match(inspectorStyle.textContent, /\.xhctx-harness-root/)

const requestDefinition = eventDefinitions.find(item => item.kind === 'xharness-context-request')
const event = {
  type: 'request/header',
  seq: 11,
  time: 22,
  data: {
    header: {
      config: { provider: 'openai', model: 'qwen' },
      input: [{ role: 'user', content: 'hello' }],
      options: { step: 3 },
    },
  },
}
const match = requestDefinition.match(event)
assert.deepEqual({ ...match }, { id: '11', role: 'start' })
const state = requestDefinition.start({}, {
  event,
  location: {
    kind: 'step',
    turn: { turn: 2 },
    step: { step: 3 },
  },
})
const node = requestDefinition.buildViewNode({
  key: 'request-11',
  kind: requestDefinition.kind,
  id: '11',
  state,
})
const builder = viewDefinitions[0].create()
const snapshot = builder.replace({ nodes: [node], timeline: { turnOrder: [], turns: new Map() } })
assert.equal(snapshot.requests.length, 1)
assert.equal(snapshot.requests[0].header.input[0].content, 'hello')
assert.equal(snapshot.requests[0].turn, 2)
assert.equal(snapshot.requests[0].step, 3)

console.log('context inspector plugin smoke test passed')
