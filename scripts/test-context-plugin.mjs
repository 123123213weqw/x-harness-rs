#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const pluginPath = new URL(
  '../ui/dist/plugins/@xlang/xharness-client-ui-context/client.js',
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
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
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
  ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale'],
)

const eventDefinitions = []
const viewDefinitions = []
const tabs = []
const labels = new Map()
const ctx = {
  locale: {register: (id, value) => labels.set(id, value), bind: id => key => labels.get(id).zh[key]},
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

assert.equal(eventDefinitions.length, 3)
assert.equal(viewDefinitions.length, 1)
assert.deepEqual(tabs.map(tab => tab.options.id), ['harness'], 'Context must not register a hidden or visible page')
assert.equal(tabs[0].options.order, 30)
assert.doesNotMatch(source, /function ContextView|function ContextRequestView|function FilterBar/)
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

// Harness, including the empty/loading face, opts into the upstream
// independent scrollport contract. No stream-driven scroll reset is needed.
for (const tab of tabs) {
  for (const requests of [[], snapshot.requests]) {
    const tree = tab.component({useSession: select => select({
      views: new Map([['xharness-context', {requests, compactions: []}]]),
    })})
    assert.equal(tree.props['data-conversation-composer-overlay'], '')
    assert.match(tree.props.className, /xhctx-root/)
  }
}
assert.match(inspectorStyle.textContent, /grid-auto-rows:max-content/)
assert.match(inspectorStyle.textContent, /min-height:0/)
assert.equal((inspectorStyle.textContent.match(/var\(--dsh-composer-height,150px\)/g) ?? []).length, 2,
  'desktop and narrow layouts must both reserve the dynamic composer height')
console.log('Harness-only registration, projection and layout contract tests passed')

// Exact per-request attribution, cached input included, late samples excluded.
const usageDef=eventDefinitions.find(d=>d.kind==='xharness-context-usage');
function usageNode(seq,turn,step,usage) {
 const state=usageDef.start({}, {event:{seq,data:{chunk:{kind:'usage',data:usage}}},location:{kind:'step',turn:{turn},step:{step}}});
 return usageDef.buildViewNode({key:'usage-'+seq,state});
}
const measured=builder.replace({nodes:[node,usageNode(12,2,3,{input_tokens:454,cache_read_tokens:116992}),usageNode(13,1,3,{input_tokens:999999})]});
assert.equal(measured.requests[0].usage.input_tokens,454);
assert.equal(measured.requests[0].usage.cache_read_tokens,116992);
const next={...node,key:'next',anchorSeq:14,data:{...node.data,seq:14,step:4}};
const changed=builder.replace({nodes:[node,next,usageNode(15,2,3,{input_tokens:999})]});
assert.equal(changed.requests[1].usage,undefined);

// Harness is a payload-only view. Do not reintroduce runtime/assembly panels.
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.children)]
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree == null || typeof tree === 'boolean') return ''
  return typeof tree === 'object' ? text(tree.children) : String(tree)
}
const harness = tabs.find(tab => tab.options.id === 'harness')
const draw = header => harness.component({sessionId: 'fixture', ...harness.options.inject(),
  useSession: select => select({views:new Map([['xharness-context',{requests:[{seq:1,header}],compactions:[]}]])})})
const header = {system:'Actual system prompt', input:[{role:'system',content:'Must not duplicate header.system'},{role:'user',content:'Private user body'}],
  tools:[{name:'bash',description:'Run a command',parameters:{type:'object',properties:{command:{type:'string'}}}}],
  options:{prompt:{assemblyId:'hidden assembly hash'},context:{policy:{name:'hidden policy'}}}}
let tree = draw(header)
assert.deepEqual(elements(tree).filter(e => e.type === 'h3').map(text), ['系统提示词','工具'])
assert.match(text(tree), /Actual system prompt/)
assert.match(text(tree), /Run a command/)
assert.match(text(tree), /"command"/)
assert.doesNotMatch(text(tree), /Private user body|Must not duplicate|hidden assembly|hidden policy|tok|Context Policy|Runtime Route|Prompt Assembly/)
assert.equal(elements(tree).find(e=>e.type==='select').props.disabled, true, 'single request cannot select another snapshot')
assert.equal(elements(tree).find(e=>e.type==='details').props.open, undefined, 'tool details start collapsed')
assert.equal(elements(tree).some(e=>e.props.className==='xhctx-pipeline'), false)
assert.doesNotMatch(inspectorStyle.textContent, /xhctx-pipeline|xhctx-assembly-section|xhctx-harness-columns|xhctx-card|xhctx-filterbar|xhctx-compaction-banner|xhctx-diff/)
const dictionaries=labels.get('xharness.harness')
assert.deepEqual(Object.keys(dictionaries.zh).sort(),Object.keys(dictionaries.en).sort())
assert.equal(dictionaries.en.system,'System prompt')
assert.equal(dictionaries.en.tools,'Tools')
for (const reason of ['capture_disabled','archive_failed']) {
  tree=draw({input:[],tools:[],options:{auditSnapshot:{kind:'omitted',reason},toolCount:19}})
  assert.match(text(tree), /19 个工具/)
  assert.doesNotMatch(text(tree), /0 个工具|没有匹配|此请求没有/)
  assert.equal(elements(tree).filter(e=>e.type==='input').length,0, 'no search over uncaptured tools')
  assert.match(text(tree), reason==='archive_failed'?/捕获失败/:/未开启完整诊断/)
}
tree=draw({input:[],tools:[],options:{auditSnapshot:{kind:'omitted'},toolCount:-1}})
assert.doesNotMatch(text(tree), /-1 个工具|0 个工具/)
tree=draw({input:[{role:'system',content:'First'},{role:'system',content:'Second'}],tools:[]})
assert.equal(text(elements(tree).find(e=>e.props.className==='xhctx-system-text')), 'First\n\nSecond')
tree=draw({system:'',input:[{role:'system',content:'Ignored'}],tools:[]})
assert.match(text(tree),/此请求没有系统提示词/)
assert.doesNotMatch(text(tree),/Ignored/)
tree=draw({input:[{role:'system',content:[{type:'text',text:'Structured prompt'}]}],tools:[null,{name:42,description:{},parameters:[]}]})
assert.match(text(tree),/Structured prompt/)
assert.doesNotMatch(text(tree),/\[object Object\]|NaN/)
console.log('Harness minimal view: payload, omitted vs empty, malformed, multi-system, bilingual labels passed')
