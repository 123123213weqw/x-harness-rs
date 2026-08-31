import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeTestApi } from './runtime-source-test-harness.mjs'

const { Session } = runtimeTestApi()
const id = 'question-late-answer:question:fixture'
const message = { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture answer' }] }
const durable = { seq: 1, time: 1, type: 'user/message', surfaceOp: 'append', data: message }
const row = (messageId = id, placement = 'steering') => ({ id: messageId, placement, message: { ...message, id: messageId } })
function fixture(history = []) {
  const api = { sessions: { history: async () => ({ result: { ok: true, value: { events: history.map(event => ({ event })), hasMore: false } } }) } }
  return new Session('fixture', api, {})
}
function queue(session, items) {
  session.handleMuxEnvelope('queue-frame', { type: 'session/queue', sessionId: 'fixture', items })
}
const pending = session => session.queueMirror.snapshot().map(item => item.messageId)

test('late answer consumed before its queue frame cannot reappear at the tail', async () => {
  const session = fixture([durable]); await session.open()
  queue(session, [row()])
  assert.deepEqual(pending(session), [])
})

test('consumption retires the tail and a subsequent stale snapshot cannot resurrect it', async () => {
  const session = fixture(); await session.open()
  queue(session, [row()]); assert.deepEqual(pending(session), [id])
  session.handleMuxEnvelope('event', { type: 'session/event', sessionId: 'fixture', event: durable })
  assert.deepEqual(pending(session), [])
  queue(session, [row()]); assert.deepEqual(pending(session), [])
  assert.equal(session.events.filter(event => event.type === 'user/message').length, 1, 'durable answer is retained, not hidden or deleted')
})

test('history/reconnect clears consumed steering without losing unanswered or queued input', async () => {
  const session = fixture([durable])
  queue(session, [row(), row('unconsumed'), row('queued', 'queued')])
  await session.open()
  assert.deepEqual(pending(session), ['unconsumed', 'queued'])
  session.handleMuxEnvelope('subscribed', { type: 'session/subscribed', sessionId: 'fixture', lastSeq: 1 })
  queue(session, [row(), row('unconsumed')])
  assert.deepEqual(pending(session), ['unconsumed'])
})
