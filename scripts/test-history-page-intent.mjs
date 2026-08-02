import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compile, harness } from './conversation-test-harness.mjs'
const { HistoryPageIntent } = harness(compile().test).plugin
const ready = { ready: true, hasMore: true, loading: false, following: false, head: 100, top: 120, viewport: 600 }

test('opening/reflow alone never admits a history page; only upward reader intent arms it', () => {
 const gate = new HistoryPageIntent()
 assert.equal(gate.shouldLoad(ready), false)
 gate.arm(); assert.equal(gate.shouldLoad({ ...ready, top: 300 }), false)
 assert.equal(gate.shouldLoad(ready), true)
 gate.cancel(); assert.equal(gate.shouldLoad(ready), false)
})

test('automatic and manual paging share a synchronous gate before the next React/RPC tick', () => {
 const gate = new HistoryPageIntent()
 gate.arm(); assert.equal(gate.shouldLoad(ready), true); assert.equal(gate.begin(), true)
 for (let i = 0; i < 30; i++) {
  gate.arm(); assert.equal(gate.shouldLoad(ready), false); assert.equal(gate.begin(), false)
 }
 gate.end(); assert.equal(gate.shouldLoad({ ...ready, head: 50, top: 0 }), false, 'completion cannot drain more pages')
 gate.arm(); assert.equal(gate.shouldLoad({ ...ready, head: 50 }), true)
 assert.equal(gate.begin(), true); gate.end()
 assert.equal(gate.begin(), true, 'explicit retry does not require another wheel')
})

test('busy/error/EOF/following cancel stale intents; bad or unmeasured geometry cannot fetch', () => {
 for (const blocked of [{ ready: false }, { hasMore: false }, { loading: true }, { following: true }]) {
  const gate = new HistoryPageIntent(); gate.arm()
  assert.equal(gate.shouldLoad({ ...ready, ...blocked }), false)
  assert.equal(gate.shouldLoad(ready), false, 'passive readiness cannot resurrect an old gesture')
 }
 for (const geometry of [{ head: null }, { top: NaN }, { top: Infinity }, { viewport: 0 }, { viewport: NaN }, { viewport: -1 }]) {
  const gate = new HistoryPageIntent(); gate.arm(); assert.equal(gate.shouldLoad({ ...ready, ...geometry }), false)
 }
})

test('success, rejected provider and no-op all release one flight without arming another page', async () => {
 for (const finish of [() => Promise.resolve(), () => Promise.reject(Error('network')), () => undefined]) {
  const gate = new HistoryPageIntent(); gate.arm(); assert.equal(gate.begin(), true)
  try { await finish() } catch {} finally { gate.end() }
  assert.equal(gate.shouldLoad(ready), false); assert.equal(gate.begin(), true); gate.end()
 }
})
