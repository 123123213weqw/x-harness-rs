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

// This models a large journal, not a large first response: production asks for
// 50 visible messages and must not eagerly restore all 100,000 old messages.
const largePage = (before = 100_000) => {
  const start = Math.max(0, before - 50)
  return { events: Array.from({ length: before - start }, (_, i) => row(start + i)), hasMore: start > 0 }
}
function blockedRead(signal) {
  const pending = deferred()
  const abort = () => pending.reject(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return { signal, release: (value = largePage()) => pending.resolve(reply(value)),
    promise: pending.promise.finally(() => signal?.removeEventListener('abort', abort)) }
}

test('100,000-message chat cancels obsolete reconnect reads without cancelling agent work', async () => {
  const blocked = [], promptController = new AbortController()
  let block = true, prompts = 0
  const manager = new SessionManager({ sessions: {
    history: async (_payload, signal) => {
      if (!block) return reply(largePage())
      const read = blockedRead(signal); blocked.push(read); return read.promise
    },
    prompt: async (_payload, signal) => { prompts++; assert.equal(signal, promptController.signal); return { result: { ok: true, value: { accepted: true } } } },
  } }, {})
  const s = manager.get('large'), old = s.open()
  await tick()
  try {
    s.invalidateConnectionGeneration()
    assert.equal(blocked[0].signal?.aborted, true, 'generation death must abort the obsolete history HTTP request')
    block = false; await s.resync(); await old
    assert.equal(s.openState, 'open'); assert.equal(s.events.length, 50); assert.equal(s.hasMore, true)
    await s.prompt([{ type: 'text', text: 'continue existing work' }], 'queue', promptController.signal)
    s.invalidateConnectionGeneration(); await s.resync()
    assert.equal(promptController.signal.aborted, false, 'read cancellation must not become turn cancellation')
    assert.equal(prompts, 1, 'recovery must never resubmit a prompt')
  } finally { blocked.forEach(read => read.release()); await old }
})

test('latest intent aborts a blocked older page and publishes the validated tail plus live events', async () => {
  let pending
  const calls = []
  const manager = new SessionManager({ sessions: { history: async (payload, signal) => {
    calls.push(payload)
    if (payload.beforeSeq === undefined) return reply(largePage())
    pending = blockedRead(signal); return pending.promise
  } } }, {})
  const s = manager.get('large'); s.setHistoryOpenTarget({ kind: 'anchor', seq: 0 })
  const opening = s.open(); await tick()
  try {
    assert.equal(s.openState, 'loading'); assert.equal(s.events.length, 0, 'keep anchor restoration atomic')
    s.acceptLiveEvent(row(100_000).event)
    s.setHistoryOpenTarget({ kind: 'latest' })
    assert.equal(pending.signal?.aborted, true, 'do not wait for an irrelevant old page or its transport timeout')
    await opening
    assert.equal(s.openState, 'open'); assert.equal(s.baseSeq, 99_950)
    assert.equal(s.events.at(-1).seq, 100_000); assert.equal(s.events.length, 51)
    assert.equal(calls.length, 2, 'no redundant fresh-tail request')
    assert.equal(s.hasMore, true, 'older history remains available')
  } finally { pending?.release(); await opening }
})

test('reader hint cannot abort reconnect restoration of an already committed large window', async () => {
  let pending, block = false
  const manager = new SessionManager({ sessions: { history: async (payload, signal) => {
    if (block && payload.beforeSeq !== undefined) { pending = blockedRead(signal); return pending.promise }
    return reply(largePage(payload.beforeSeq))
  } } }, {})
  const s = manager.get('large'); await s.open(); await s.loadOlder()
  const committed = s.events; block = true
  const recovery = s.resync(); await tick()
  try {
    s.setHistoryOpenTarget({ kind: 'latest' })
    assert.equal(pending.signal?.aborted, false, 'existing windows retain their atomic reconnect contract')
    assert.equal(s.events, committed)
    pending.release(largePage(99_950)); await recovery
    assert.equal(s.openState, 'open'); assert.equal(s.baseSeq, 99_900)
    assert.equal(s.events.length, committed.length); assert.equal(s.events.at(-1).seq, 99_999)
  } finally { pending?.release(); await recovery }
})

test('addressed subagent history uses the same read-only generation cancellation', async () => {
  let pending, block = true
  const manager = new SessionManager({ subagents: { history: async (_payload, signal) => {
    if (!block) return reply(largePage())
    pending = blockedRead(signal); return pending.promise
  } } }, {})
  const s = manager.get('child'); s.configureSubagent({ parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' })
  const opening = s.open(); await tick()
  try {
    s.invalidateConnectionGeneration()
    assert.equal(pending.signal?.aborted, true)
    block = false; await s.resync(); await opening
    assert.equal(s.openState, 'open'); assert.equal(s.events.length, 50)
  } finally { pending?.release(); await opening }
})

test('latest then a new bookmark in the same tick honors the last reader intent', async () => {
  let pending
  const calls = []
  const manager = new SessionManager({ sessions: { history: async (payload, signal) => {
    calls.push(payload)
    if (calls.length === 2) { pending = blockedRead(signal); return pending.promise }
    return reply(largePage(payload.beforeSeq))
  } } }, {})
  const s = manager.get('large'); s.setHistoryOpenTarget({ kind: 'anchor', seq: 0 })
  const opening = s.open(); await tick()
  try {
    s.setHistoryOpenTarget({ kind: 'latest' })
    s.setHistoryOpenTarget({ kind: 'anchor', seq: 99_925 })
    assert.equal(pending.signal?.aborted, true)
    await opening
    assert.equal(s.openState, 'open'); assert.equal(s.baseSeq, 99_900)
    assert.equal(s.events.length, 100); assert.equal(calls.length, 3)
  } finally { pending?.release(); await opening }
})

test('repeated reconnects keep only one outstanding history read, independently per chat', async () => {
  let inFlight = 0, peak = 0
  const reads = []
  const manager = new SessionManager({ sessions: { history: async (_payload, signal) => {
    inFlight++; peak = Math.max(peak, inFlight)
    const pending = blockedRead(signal); reads.push(pending)
    try { return await pending.promise } finally { inFlight-- }
  } } }, {})
  const s = manager.get('large'), other = manager.get('other'), operations = [s.open(), other.open()]
  await tick()
  try {
    for (let i = 0; i < 12; i++) {
      s.invalidateConnectionGeneration(); await tick()
      assert.equal(inFlight, 1, 'only the other chat remains pending after cancellation')
      operations.push(s.resync()); await tick()
      assert.equal(inFlight, 2)
    }
    assert.equal(reads[1].signal.aborted, false, 'one chat cannot cancel another chat’s history')
    reads.at(-1).release(); reads[1].release(); await Promise.all(operations)
    assert.equal(inFlight, 0); assert.equal(peak, 2)
    assert.equal(s.openState, 'open'); assert.equal(other.openState, 'open')
  } finally { reads.forEach(read => read.release()); await Promise.all(operations) }
})

test('full 100,000-event bookmark restoration remains lossless while live events arrive', async () => {
  let calls = 0, live = 100_000
  const manager = new SessionManager({ sessions: { history: async payload => {
    calls++; assert.equal(payload.maxMessages, 50)
    if (calls % 100 === 0) session.acceptLiveEvent(row(live++).event)
    return reply(largePage(payload.beforeSeq))
  } } }, {})
  const session = manager.get('full-large')
  session.setHistoryOpenTarget({ kind: 'anchor', seq: 0 })
  await session.open()
  assert.equal(session.openState, 'open'); assert.equal(calls, 2_000)
  assert.equal(session.events.length, 100_020); assert.equal(session.hasMore, false)
  assert.equal(session.baseSeq, 0); assert.equal(session.events.at(-1).seq, 100_019)
  for (let i = 0; i < session.events.length; i++) assert.equal(session.events[i].seq, i, 'no loss, duplicate, or reordering')
})
