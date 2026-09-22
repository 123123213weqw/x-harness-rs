/** Typed no-op/interrupted compaction: actual source reducers, codecs and renderer. */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { compileSourceModules } from './build-source-modules.mjs'
import { conversationFixture } from './fixtures/conversation-source-fixture.mjs'
import { runtimeTestApi } from './runtime-source-test-harness.mjs'

const conversationId = '@xharness/dsh-client-ui-conversation'
const trajectoryId = '@xharness/dsh-client-ui-trajectory'
const built = compileSourceModules('ui', [
  { id: conversationId, source: 'src/modules/conversation/index.ts' },
  { id: trajectoryId + '/test', source: 'src/modules/trajectory/test-exports.ts' },
])
const runtime = runtimeTestApi()
const api = conversationFixture(built.get(conversationId).bytes.toString(), ['compactionDefinition', 'commandDefinition', 'CompactionProgressCard'], { runtime }).api
const plain = value => JSON.parse(JSON.stringify(value))
const event = (type, seq, data) => ({ event: { type, seq, time: 1000 + seq * 1000, data } })
const cases = [
  ['no_benefit', undefined, 'skipped'],
  ['no_eligible_source', undefined, 'skipped'],
  ['interrupted', 'interrupted by new input', 'cancelled'],
  ['failed', 'provider authentication failed', 'failed'],
  [undefined, 'legacy cancellation is not reclassified by text', 'failed'],
]
function drive(definition, matches) {
  let state
  for (const match of matches) state = state === undefined ? definition.start({}, match) : definition.update({ state }, match)
  return definition.buildViewNode({ key: 'compaction:c', id: 'c', matches, locations: [], target: 'chat', state })
}
function assembler(definition) {
  return new runtime.ConversationNodeAssembler(
    { entries: () => [definition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => {
      let nodes = new Map()
      return { empty: [], replace: value => { nodes = new Map(value.nodes.map(n => [n.key, n])); return [...nodes.values()] }, apply: value => { for (const n of value.upserts) nodes.set(n.key, n); return [...nodes.values()] } }
    } }] },
  )
}
const snapshot = target => plain(target.snapshot('chat'))
let checks = 0
for (const manual of [false, true]) for (const [outcome, error, phase] of cases) {
  const sourceCommandId = manual ? 'cmd' : undefined
  const run = event('command/run', 9, { commandId: 'cmd', name: 'compact', args: '' })
  const start = event('compaction/start', 10, { compactionId: 'c', turn: manual ? null : 0, ...(sourceCommandId ? { sourceCommandId } : {}) })
  const end = event('compaction/end', 12, { ...start.event.data, ...(outcome ? { outcome } : {}), ...(error ? { error } : {}) })
  const definition = manual ? api.commandDefinition : api.compactionDefinition
  const raw = manual ? [run, start, end] : [start, end]
  const cold = drive(definition, raw)
  const data = manual ? cold.data.compaction : cold.data
  assert.equal(data.status, phase)
  assert.equal(data.outcome, outcome)
  assert.equal(data.error, error ?? null)
  assert.equal(data.summary, undefined, 'skip/error cannot claim a committed summary')
  assert.equal(data.endedAt, end.event.time)
  const projected = { ...end, view: { for: 'compaction', view: { schemaVersion: 1, id: 'c', anchorSeq: 10, time: start.event.time, phase, endedAt: end.event.time, ...(sourceCommandId ? { sourceCommandId } : {}), ...(outcome ? { outcome } : {}), ...(error ? { error } : {}) } } }
  const endOnly = drive(definition, [projected])
  assert.deepEqual(plain(manual ? endOnly.data.compaction : endOnly.data), plain(data), 'terminal-only projected page preserves typed outcome')
  const timelineInput = manual ? raw : [event('turn/start', 1, { turn: 0 }), ...raw]
  const live = assembler(definition)
  for (const match of timelineInput) { live.append(match); live.flush() }
  const restored = assembler(definition); restored.replaceWindow(timelineInput, false); restored.flush()
  assert.deepEqual(snapshot(live), snapshot(restored), 'live and restored reducer agree')
  for (let split = 0; split <= timelineInput.length; split++) {
    const resumed = assembler(definition); resumed.replaceWindow(timelineInput.slice(0, split), false); resumed.flush()
    for (const match of timelineInput.slice(split)) { resumed.append(match); resumed.flush() }
    assert.deepEqual(snapshot(resumed), snapshot(restored), 'reconnect at every cut'); checks++
  }
  const lateProgress = event('compaction/progress', 13, { ...start.event.data, progress: { stage: 'summarizing', calls: 1, completedParts: 0, splits: 0, retries: 0 } })
  const node = drive(definition, [...raw, lateProgress])
  assert.deepEqual(plain(manual ? node.data.compaction : node.data), plain(data), 'late progress cannot resurrect terminal compaction')
  const tree = api.CompactionProgressCard({ data, t: key => key })
  assert.equal(tree.props['data-compaction-running'], undefined)
  assert.equal(tree.props['data-state'], phase === 'failed' ? 'error' : phase)
  const serialized = JSON.stringify(tree)
  assert.ok(serialized.includes(phase === 'skipped' ? 'xh.compact.skipped' : phase === 'cancelled' ? 'xh.compact.cancelled' : 'xh.compact.failed'))
  if (phase !== 'failed') assert.equal(tree.props.children[0].props.role, 'status', 'no-op/cancel is not a failure alert')
  checks += 10
}
for (const fixture of JSON.parse(readFileSync('tests/fixtures/compaction-ui.json')).filter(item => !item.error)) {
  const definition = fixture.manual ? api.commandDefinition : api.compactionDefinition
  const matches = fixture.events.map(value => ({event:value})).filter(match => definition.match(match.event))
  const legacy = drive(definition, matches)
  const typed = drive(definition, matches.map(match => match.event.type === 'compaction/end' ? {...match,event:{...match.event,data:{...match.event.data,outcome:'applied'}}} : match))
  assert.deepEqual(plain(typed), plain(legacy), 'explicit applied preserves existing committed summary/card')
  checks++
}
for (const outcome of ['unknown_success', 3, {}]) assert.throws(() => api.compactionDefinition.match(event('compaction/end', 2, { compactionId: 'c', outcome }).event), /invalid compaction\/end/)

for (const data of [{outcome:'no_benefit',error:'failure'}, {outcome:'no_eligible_source',error:'failure'}, {outcome:'interrupted'}, {outcome:'failed',error:''}, {outcome:'applied',error:'failure'}]) assert.throws(() => api.compactionDefinition.match(event('compaction/end', 2, {compactionId:'c',...data}).event), /invalid compaction\/end/)

// The trajectory ledger is independently typed and must also say skipped or
// interrupted, never "Context compacted" for a surface-neutral operation.
let registration
const jsx = (type, props) => ({ type, props })
vm.runInNewContext(built.get(trajectoryId + '/test').bytes.toString(), { console, Map, Set, WeakMap, WeakSet, TextEncoder, setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} } }, window: { __ModuleLoader__: { load: row => { registration = row } } } })
const trajectory = registration.factory(name => {
  if (name === '@xharness/dsh-client-runtime/client') return runtime
  if (name === '@xharness/dsh-client-ui-primitives') return new Proxy({}, { get: (_t, key) => String(key) })
  if (name === 'react') return { memo: fn => fn, useEffect() {}, useLayoutEffect() {}, useMemo: fn => fn(), useRef: value => ({ current: value }), useState: value => [value, () => {}], useCallback: fn => fn }
  if (name === 'react-dom') return { flushSync: fn => fn() }
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
  throw Error(name)
})
const definitions = []
trajectory.apply({ conversationEvents: { register: definition => { definitions.push(definition); return () => {} } }, conversationViews: { register: () => () => {} }, effect: fn => fn(), locale: { register: () => () => {}, bind: () => key => key }, slots: { inject: (_id, fn) => fn(), register: () => () => {} } })
const definition = definitions.find(d => d.kind === 'trajectory-compaction')
for (const [outcome, error, phase] of cases) {
  const start = event('compaction/start', 10, { compactionId: 'c', turn: null })
  const end = event('compaction/end', 12, { compactionId: 'c', turn: null, ...(outcome ? { outcome } : {}), ...(error ? { error } : {}) })
  const contribution = drive(definition, [start, end])
  const request = contribution.data.request
  assert.equal(request.status, phase === 'failed' ? 'error' : phase)
  assert.equal(request.outcome, outcome)
  assert.equal(request.summary, undefined)
  assert.equal(trajectory.isTrajectorySnapshot({ eventNodes: [], eventLocations: new Map(), requests: [request], callSchemas: new Map(), partial: null, runningCalls: [] }), true)
  const layout = trajectory.deriveTrajectoryLayout({ nodes: [], partial: null, runningCalls: [], requests: [request], callSchemas: new Map() })
  const cell = layout.flatMap(turn => turn.groups).flatMap(group => group.cells).find(c => c.kind === 'compacted')
  assert.ok(cell)
  if (phase !== 'failed') { assert.notEqual(cell.text, 'Context compacted'); assert.equal(cell.isError, undefined); assert.equal(cell.compactionTerminalState, phase) }
  assert.notEqual(cell.timeSeconds, null)
  checks += 7
}
console.log(`compaction terminal outcomes: ${checks} source reducer/schema/render checks passed`)
