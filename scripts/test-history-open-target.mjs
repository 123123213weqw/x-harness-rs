/** Actual Runtime Session, synthetic wire pages: reopen targets cannot alter
 * pagination, reconnect atomicity, validation, or live-event stitching. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeTestApi } from './runtime-source-test-harness.mjs'
const { SessionManager } = runtimeTestApi()
const row = seq => ({ event: { seq, time: seq, type: 'fixture/message', data: { text: `body ${seq}` } } })
const pageOf = (before = 201) => {
  const start = Math.max(0, before - 50)
  return { events: Array.from({ length: before - start }, (_, i) => row(start + i)), hasMore: start > 0 }
}
const reply = value => ({ result: { ok: true, value } })
const deferred = () => Promise.withResolvers()
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function fixture() {
  const calls = []
  const manager = new SessionManager({ sessions: { history: async p => { calls.push(p); return reply(pageOf(p.beforeSeq)) } } }, {})
  // A real LRU owner; the idle fixture is deliberately not the current chat.
  return { session: manager.get('fixture'), calls }
}
async function expanded() {
  const f = fixture()
  await f.session.open()
  while (f.session.hasMore) await f.session.loadOlder()
  assert.equal(f.session.baseSeq, 0)
  assert.equal(f.session.unloadHistory(), true)
  f.calls.length = 0
  return f
}

test('latest reopen fetches one tail page; older pages remain reachable without duplicates', async () => {
  const { session: s, calls } = await expanded()
  s.setHistoryOpenTarget({ kind: 'latest' })
  await s.open()
  assert.equal(s.openState, 'open'); assert.equal(calls.length, 1)
  assert.equal(s.baseSeq, 151); assert.equal(s.hasMore, true)
  while (s.hasMore) await s.loadOlder()
  assert.deepEqual(Array.from(s.events, e => e.seq), Array.from({ length: 201 }, (_, i) => i))
  assert.equal(calls.length, 5)
})

test('reader anchor stops at its containing page, not the previous earliest loaded page', async () => {
  const { session: s, calls } = await expanded()
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 125 })
  await s.open()
  assert.equal(calls.length, 2); assert.equal(s.baseSeq, 101); assert.equal(s.hasMore, true)
  assert.equal(s.events.some(e => e.seq === 125), true)
  await s.loadOlder(); assert.equal(s.baseSeq, 51)
})

test('absent or older-provider hint conservatively restores the old range', async () => {
  const { session: s, calls } = await expanded()
  s.setHistoryOpenTarget({ kind: 'latest' }); s.setHistoryOpenTarget(undefined)
  await s.open()
  assert.equal(calls.length, 5); assert.equal(s.baseSeq, 0); assert.equal(s.hasMore, false)
})

test('sequence zero is a valid bookmark; invalid sequence hints cannot replace the last valid target', async () => {
  const { session: s, calls } = await expanded()
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 0 })
  for (const seq of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => s.setHistoryOpenTarget({ kind: 'anchor', seq }), /safe event sequence/)
  }
  await s.open(); assert.equal(s.baseSeq, 0); assert.equal(calls.length, 5)
})

for (const outcome of ['success', 'rpc-error', 'transport-error']) test(`explicit latest supersedes an in-flight anchor page (${outcome})`, async () => {
  const { session: s } = await expanded(), pending = deferred()
  let calls = 0
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 0 })
  s.history = async p => { calls++; return p.beforeSeq === undefined ? reply(pageOf()) : pending.promise }
  const opening = s.open(); await tick()
  assert.equal(s.events.length, 0, 'no tail-first publication before anchor restoration')
  s.setHistoryOpenTarget({ kind: 'latest' })
  if (outcome === 'transport-error') pending.reject(Error('superseded transport failed'))
  else pending.resolve(outcome === 'rpc-error' ? { result: { ok: false, error: { message: 'superseded request failed' } } } : reply(pageOf(151)))
  await opening
  assert.equal(s.openState, 'open'); assert.equal(s.baseSeq, 151); assert.equal(calls, 2)
})

test('changing a cold bookmark while a page is pending reaches the newer bookmark', async () => {
  const { session: s } = await expanded(), pending = deferred()
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 125 })
  s.history = async p => p.beforeSeq === 151 ? pending.promise : reply(pageOf(p.beforeSeq))
  const opening = s.open(); await tick()
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 25 }); pending.resolve(reply(pageOf(151)))
  await opening; assert.equal(s.baseSeq, 1); assert.equal(s.hasMore, true)
})

test('reconnect keeps the committed window atomic even when the reader now follows latest', async () => {
  const { session: s } = fixture()
  await s.open(); await s.loadOlder(); await s.loadOlder()
  const events = s.events, pending = deferred()
  s.setHistoryOpenTarget({ kind: 'latest' })
  s.history = async p => p.beforeSeq === 151 ? pending.promise : reply(pageOf(p.beforeSeq))
  const sync = s.resync(); await tick()
  assert.equal(s.events, events, 'retained window stays visible while restoring')
  pending.resolve(reply(pageOf(151))); await sync
  assert.equal(s.baseSeq, 51); assert.equal(s.events.length, events.length)
})

test('missing bookmark range stays explicit and retryable, without silently going to bottom', async () => {
  const { session: s } = await expanded()
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 25 })
  s.history = async () => reply({ ...pageOf(), hasMore: false })
  await s.open(); assert.equal(s.openState, 'error'); assert.equal(s.events.length, 0)
  s.history = async p => reply(pageOf(p.beforeSeq))
  await s.open(); assert.equal(s.openState, 'open'); assert.equal(s.baseSeq, 1)
})

test('sparse projected pages remain valid; malformed anchor restore pages never publish', async () => {
  for (const bad of [[row(110), row(109)], [row(110), row(151)], [row(110), row(110)], []]) {
    const { session: s } = await expanded()
    s.setHistoryOpenTarget({ kind: 'anchor', seq: 125 })
    s.history = async p => reply(p.beforeSeq === undefined ? pageOf() : { events: bad, hasMore: false })
    await s.open(); assert.equal(s.openState, 'error'); assert.equal(s.events.length, 0)
  }
  const { session: s } = await expanded()
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 125 })
  s.history = async p => { const value = pageOf(p.beforeSeq); return reply({ ...value, events: value.events.filter(e => e.event.seq % 7 !== 3) }) }
  await s.open(); assert.equal(s.openState, 'open'); assert.equal(s.baseSeq, 102)
})

test('live tail stitching deduplicates history overlap during anchor restore', async () => {
  const { session: s } = await expanded(), pending = deferred()
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 125 })
  s.history = async p => p.beforeSeq === undefined ? pending.promise : reply(pageOf(p.beforeSeq))
  const opening = s.open(); await tick()
  s.acceptLiveEvent(row(200).event); s.acceptLiveEvent(row(201).event)
  pending.resolve(reply(pageOf())); await opening
  assert.equal(s.openState, 'open'); assert.equal(s.events.at(-1).seq, 201)
  assert.equal(s.events.filter(e => e.seq === 200).length, 1); assert.equal(s.baseSeq, 101)
})

test('stale generation and a different session cannot publish the old bookmark request', async () => {
  const { session: s } = await expanded(), pending = deferred(), other = fixture().session
  s.setHistoryOpenTarget({ kind: 'anchor', seq: 0 })
  s.history = async p => p.beforeSeq === undefined ? reply(pageOf()) : pending.promise
  const opening = s.open(); await tick(); s.openGeneration++; s.openState = 'cold'
  other.setHistoryOpenTarget({ kind: 'latest' }); await other.open()
  pending.resolve(reply(pageOf(151))); await opening
  assert.equal(s.events.length, 0); assert.equal(other.baseSeq, 151); assert.equal(other.openState, 'open')
})
