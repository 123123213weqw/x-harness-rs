import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compile, harness, controller, tick } from './conversation-test-harness.mjs'
const api = harness(compile().test).plugin
const position = { anchorKey: 'older', anchorTop: 12, scrollTop: 300 }

test('reader memory, explicit intents and hidden views are isolated per session', () => {
 const memory = new api.ChatScrollMemory(), a = memory.forSession('a'), b = memory.forSession('b')
 const calls = []
 const off = a.subscribeFollow(() => calls.push('a')), offB = b.subscribeFollow(() => calls.push('b'))
 a.save(position); b.save(position); memory.requestFollow('a')
 assert.equal(a.read(), null); assert.equal(b.read(), position); assert.deepEqual(calls, ['a'])
 off(); a.save(position); memory.requestFollow('a')
 assert.equal(a.read(), null, 'submit while hidden clears only this session bookmark')
 assert.deepEqual(calls, ['a']); offB(); memory.dispose(); a.save(position)
 assert.equal(a.read(), null); memory.requestFollow('b'); assert.deepEqual(calls, ['a'])
 assert.equal(typeof a.subscribeFollow(() => assert.fail('disposed handler')), 'function')
})

test('reentrant unsubscribe cannot delete a newly installed subscription or call a disposed reader', () => {
 const memory = new api.ChatScrollMemory(), seat = memory.forSession('s'), calls = []
 let second
 const first = seat.subscribeFollow(() => { calls.push('first'); second() })
 second = seat.subscribeFollow(() => calls.push('second'))
 memory.requestFollow('s'); assert.deepEqual(calls, ['first']); first()
 const third = seat.subscribeFollow(() => calls.push('third'))
 first(); memory.requestFollow('s'); assert.deepEqual(calls, ['first', 'third'])
 third(); memory.dispose()
})

test('actual InputHub dispatches one local intent before prompt; later success/rejection cannot re-arm a reader', async () => {
 for (const mode of ['queue', 'steer']) for (const ok of [true, false]) {
  const memory = new api.ChatScrollMemory(), seat = memory.forSession('s'), events = [], disposers = []
  let settle
  const receipt = new Promise(resolve => { settle = resolve })
  const { conversation, cleanup } = controller(api)
  const session = { sessionId: 's', getSnapshot: () => ({ queue: [] }), subscribe: () => () => {},
   prompt: () => { events.push('prompt'); return receipt }, readAttachment: async () => ({ ok: false, error: { message: 'missing' } }) }
  const actx = { get: () => undefined, on: () => () => {}, effect: fn => { const off = fn(); if (typeof off === 'function') disposers.push(off) } }
  const binding = { sessionId: 's', session, ctx: actx }
  const sessions = { list: { getSnapshot: () => ({ byId: {} }) }, binding: () => binding }
  const ctx = { get: name => name === 'sessions' ? sessions : name === 'conversation' ? conversation : undefined }
  const hub = new api.InputHub(ctx, k => k, id => memory.requestFollow(id)), shell = hub.shellFor(binding)
  seat.subscribeFollow(() => events.push('follow'))
  await shell.xhEditor.ready
  shell.setDraft('explicit task'); shell.submit(mode); await tick()
  assert.deepEqual(events, ['follow', 'prompt'])
  seat.save(position) // A newer reader gesture occurs while the network is pending.
  settle(ok ? { ok: true, value: { accepted: true } } : { ok: false, error: { code: 'rejected', message: 'not accepted' } })
  await tick(); await tick()
  assert.equal(seat.read(), position); assert.deepEqual(events, ['follow', 'prompt'])
  shell.setDraft(''); shell.submit(); await tick(); assert.deepEqual(events, ['follow', 'prompt'])
  disposers.forEach(off => off()); cleanup.forEach(off => off()); memory.dispose()
 }
})
