import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { compile, json } from './conversation-test-harness.mjs'
import { terminalHarness, terminalRow as row, terminalEvent as ev, terminalPrefix as prefix } from './session-terminal-test-harness.mjs'
import { generateTerminalContract, run } from './generate-session-terminal-contract.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/session-terminal.json', import.meta.url)))
const contract = JSON.parse(readFileSync(new URL('../protocol/session-terminal.schema.json', import.meta.url)))
const { runtime, plugin, conversation, session } = terminalHarness(compile().test)
function brief(value) {
  const turn = value.chat.timeline.turns.get(1)
  return json({
    status: turn?.status,
    tail: turn?.data.get('turn-tail'),
    nodes: value.chat.order.map(key => value.chat.nodes.get(key)).map(node => ({ kind: node.kind, data: node.data })),
  })
}

test('Rust-generated schema/artifacts are fresh; generation fails closed for unsupported constraints', () => {
  run(['--check'])
  assert.equal(fixture.contract, contract.contract)
  assert.equal(fixture.cases.length, 7)
  const producerKinds = contract.schemas.TurnEndData.$defs.TurnEndReasonWire.oneOf.map(value => value.properties.kind.const)
  assert.deepEqual([...new Set(fixture.cases.map(value => value.live.data.reason.kind))].sort(), producerKinds.sort(), 'every current producer variant has a real Rust fixture')
  for (const key of ['pattern', 'not', 'allOf', 'dependentRequired']) {
    const altered = structuredClone(contract)
    altered.schemas.TurnEndData[key] = true
    assert.throws(() => generateTerminalContract(altered), /unsupported schema keyword/)
  }
  for (const shape of [
    { $ref: '#/$defs/TurnEndReasonWire', type: 'object' },
    { const: 'completed', type: 'string', minimum: 1 },
    { anyOf: [{ type: 'boolean' }], properties: {} },
    { type: 'integer', properties: {} },
    { type: 'array', items: true, maximum: 1 },
  ]) {
    const altered = structuredClone(contract); altered.schemas.TurnEndData = shape
    assert.throws(() => generateTerminalContract(altered), /unsupported schema keyword/, 'never discard sibling constraints')
  }
  for (const branches of [[{ type: 'string' }, { type: 'string' }],
    [{ type: 'object', required: ['kind'], properties: { kind: { const: 'same', type: 'string' } } },
      { type: 'object', required: ['kind'], properties: { kind: { const: 'same', type: 'string' } } }]]) {
    const altered = structuredClone(contract); altered.schemas.TurnEndData = { oneOf: branches }
    assert.throws(() => generateTerminalContract(altered), /unsupported overlapping oneOf/)
  }
  assert.throws(() => run(['--from']), /usage:/)
  const directory = mkdtempSync(join(tmpdir(), 'xh-terminal-drift-'))
  try {
    const altered = structuredClone(contract); altered.schemas.TurnEndData.properties.turn.minimum = 1
    writeFileSync(join(directory, 'session-terminal.schema.json'), JSON.stringify(altered))
    writeFileSync(join(directory, 'session-terminal.fixtures.json'), JSON.stringify(fixture))
    assert.throws(() => run(['--from', directory, '--check']), /generated terminal contract drift/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

for (const item of fixture.cases) {
  test(`${item.name}: real Rust end -> production Session/Assembler -> live/history same terminal footer and fold`, () => {
    assert.deepEqual(item.live, item.history)
    if (item.driver !== null) assert.deepEqual(item.driver, item.live.data, 'legacy Core driver emits the same owned DTO')
    assert.equal(plugin.isSessionEvent(item.live, 'turn/end'), true)
    assert.equal(plugin.TurnEndDataSchema.safeParse(item.live.data).success, true)
    assert.deepEqual(json(plugin.TurnEndDataInputSchema.parse(item.live.data)), item.live.data)
    for (const outcome of ['success', 'error', 'unknown']) {
      const live = session(), history = session()
      live.installWindow(prefix(outcome).map(row), false); live.openState = 'open'
      assert.equal(live.getSnapshot().chat.timeline.turns.get(1).data.get('turn-tail'), undefined)
      live.acceptLiveEvent(item.live)
      history.installWindow([...prefix(outcome), item.history].map(row), false)
      const a = live.getSnapshot(), b = history.getSnapshot()
      assert.deepEqual(brief(a), brief(b))
      assert.equal(a.chat.timeline.turns.get(1).status, 'closed')
      const tail = a.chat.timeline.turns.get(1).data.get('turn-tail')
      assert.ok(tail, 'closed location and UI footer agree')
      const nodes = a.chat.nodes.values()
      assert.equal(nodes.filter(node => node.kind === 'turn-tail').length, 1)
      const tool = nodes.find(node => node.kind === 'tool-call')
      assert.ok(tool)
      assert.equal(plugin.turnProcessPresentation(tool, tail, false).hidden, outcome === 'success')
      assert.equal(plugin.turnProcessPresentation(tool, tail, true).hidden, false)
      const errors = nodes.filter(node => node.kind === 'turn-error')
      assert.equal(errors.length, item.live.data.reason.kind === 'error' ? 1 : 0)
      if (errors.length) assert.equal(errors[0].data.message, item.live.data.reason.error.message)
      // Pagination suffix with no start still closes, then gains exact timing
      // when the missing prefix is prepended. Duplicate end does not add a tail.
      const partial = session(); partial.installWindow([row(item.history)], true)
      assert.ok(partial.getSnapshot().chat.timeline.turns.get(1).data.get('turn-tail'))
      partial.installWindow([...prefix(outcome), item.history].map(row), false)
      assert.deepEqual(brief(partial.getSnapshot()), brief(b))
      live.acceptLiveEvent(item.live)
      assert.deepEqual(brief(live.getSnapshot()), brief(a))
    }
  })
}

test('old aliases/error envelopes remain readable; foreign fields/carrier survive, malformed core does not', () => {
  for (const reason of [{ kind: 'aborted' }, { kind: 'stop' }, { kind: 'error' },
    { kind: 'error', failure: { code: 'LEGACY', message: 'legacy' } },
    { kind: 'error', error: { code: 'RPC', message: 'legacy', details: { extension: true } } },
    { kind: 'completed', extension: { kept: true } }]) {
    const event = { ...fixture.cases[0].live, data: { turn: 1, reason, extension: { kept: true } } }
    assert.equal(plugin.isSessionEvent(event, 'turn/end'), true)
    assert.deepEqual(json(plugin.TurnEndDataInputSchema.parse(event.data)), event.data)
    assert.ok(plugin.turnTailDefinition.match(event))
  }
  for (const data of [null, {}, { turn: 1 }, { turn: -1, reason: { kind: 'completed' } },
    { turn: 4294967296, reason: { kind: 'completed' } },
    { turn: 1.5, reason: { kind: 'completed' } }, { turn: 1, reason: { kind: 'future' } },
    { turn: 1, reason: { kind: 'error', error: {} } }, { turn: 1, reason: { kind: 'error', error: { code: 5, message: 'secret-sentinel' } } }]) {
    const terminal = { ...fixture.cases[0].live, data }, active = session()
    active.installWindow(prefix().map(row), false); active.openState = 'open'
    const before = active.getSnapshot(), events = [...active.events]
    active.acceptLiveEvent(terminal)
    const after = active.getSnapshot()
    assert.equal(after.openState, 'error'); assert.match(after.openError.message, /invalid turn\/end/)
    assert.equal(after.openError.message.includes('secret-sentinel'), false)
    assert.equal(after.chat, before.chat, 'failed live boundary did not partially publish a closed location')
    assert.deepEqual([...active.events], events)
    assert.equal(active.liveBuffer.length, 1)
    assert.throws(() => active.installWindow([...prefix(), terminal].map(row), false), /invalid turn\/end/)
    assert.equal(active.getSnapshot().chat, before.chat, 'failed history transaction preserves last good view')
  }
})

test('pinned v1 reader/producer compatibility corpus survives both upgrade directions', () => {
  const pinned = name => readFileSync(new URL('../protocol/compat/session-terminal-v1/' + name, import.meta.url), 'utf8')
  const schemaBytes = pinned('schema.json'), fixtureBytes = pinned('fixtures.json')
  // This baseline is intentionally not rewritten by normal generation. Changing
  // it is a protocol-version decision, not a way to make a failing CI green.
  assert.equal(createHash('sha256').update(schemaBytes).digest('hex'), 'de923a199ef8268e9991703f016b7093e07fe8237ae7e25562b5424bbb93c0c9')
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), '0457b6efe123af6229db4e7ecd354a6e227427331a6f6888b4c1a62d7b3ea931')
  const require = createRequire(new URL('../ui/package.json', import.meta.url))
  const ts = require('typescript'), module = { exports: {} }
  const bytes = ts.transpileModule(generateTerminalContract(JSON.parse(schemaBytes)), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(bytes, { module, exports: module.exports, require: id => { assert.equal(id, 'zod'); return require(id) } })
  const old = module.exports.TurnEndDataInputSchema
  for (const item of JSON.parse(fixtureBytes).cases) assert.equal(plugin.TurnEndDataInputSchema.safeParse(item.live.data).success, true, 'old producer -> new reader')
  for (const item of fixture.cases) assert.equal(old.safeParse(item.live.data).success, true, 'new producer -> pinned old reader')
  for (const turn of [0, 4294967295]) {
    const data = { turn, reason: { kind: 'completed' } }
    assert.equal(plugin.TurnEndDataInputSchema.safeParse(data).success, true)
    assert.equal(old.safeParse(data).success, true)
  }
  for (const turn of [-1, 0.5, 4294967296, Infinity]) {
    const data = { turn, reason: { kind: 'completed' } }
    assert.equal(plugin.TurnEndDataInputSchema.safeParse(data).success, false)
    assert.equal(old.safeParse(data).success, false)
  }
})

test('pending tool is never hidden; next turn does not inherit previous completion and failures', () => {
  const active = session(), partialPrefix = prefix().filter(event => event.type !== 'tool/result')
  active.installWindow([...partialPrefix, fixture.cases[2].history].map(row), false)
  const snapshot = active.getSnapshot(), tail = snapshot.chat.timeline.turns.get(1).data.get('turn-tail')
  const tool = snapshot.chat.nodes.values().find(node => node.kind === 'tool-call')
  assert.equal(plugin.turnProcessPresentation(tool, tail, false).hidden, false)
  active.openState = 'open'; active.acceptLiveEvent(ev(7, 'turn/start', { turn: 2 }))
  assert.equal(active.getSnapshot().chat.timeline.turns.get(2).status, 'open')
  assert.equal(active.getSnapshot().chat.timeline.turns.get(2).data.get('turn-tail'), undefined)
})

test('malformed terminal can recover from authoritative history; duplicate and foreign events cannot poison the window', async () => {
  const end = fixture.cases[0].history
  let history = [...prefix(), end].map(row)
  const active = new runtime.Session('terminal-fixture', { sessions: {
    history: async () => ({ result: { ok: true, value: { events: history, hasMore: false } } }),
  } }, {}, { conversation })
  active.installWindow(prefix().map(row), false); active.openState = 'open'
  const approval = { kind: 'approval', id: 'still-needed' }, question = { kind: 'question', id: 'still-needed' }
  active.pending.set('approval:still-needed', approval); active.pending.set('question:still-needed', question); active.pendingRev++
  const pendingRevision = active.pendingRev
  active.acceptLiveEvent({ ...end, data: { turn: 1, reason: { kind: 'future' } } })
  assert.equal(active.getSnapshot().openState, 'error')
  await active.resync()
  const good = active.getSnapshot()
  assert.equal(good.openState, 'open'); assert.equal(active.liveBuffer.length, 0)
  assert.equal(active.pending.get('approval:still-needed'), approval)
  assert.equal(active.pending.get('question:still-needed'), question)
  assert.equal(active.pendingRev, pendingRevision, 'terminal error/retry does not clear pending interactions')
  assert.ok(good.chat.timeline.turns.get(1).data.get('turn-tail'))
  active.acceptLiveEvent({ ...end, data: null })
  assert.equal(active.getSnapshot().chat, good.chat)
  assert.equal(active.getSnapshot().openState, 'open', 'seq overlap is dropped before decoding')
  const extension = ev(7, 'foreign/plugin-notice', { arbitrary: { untouched: true } })
  active.acceptLiveEvent(extension)
  assert.equal(active.getSnapshot().openState, 'open')
  assert.equal(active.events.at(-1), extension, 'not a blanket strict parser for foreign events')
  const before = active.getSnapshot().chat
  history = [...prefix(), { ...end, data: null }, extension].map(row)
  await active.resync()
  assert.equal(active.getSnapshot().openState, 'error')
  assert.equal(active.getSnapshot().chat, before)
})
