/** Opt-in integration against an isolated real Host with a local deterministic chat provider.
 * The provider holds `hold-first` for 20 seconds and immediately answers `queued-second`.
 * Never point this mutating test at a personal Host or real provider account.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import vm from 'node:vm'
import {sharedVendors} from './fixtures/shared-source-vendors.mjs'
import {checkProductionUi} from './check-production-ui.mjs'
const origin = process.env.UI_ISOLATED_HOST_ORIGIN
assert.equal(process.env.UI_ISOLATED_HOST_MUTATIONS, 'allowed', 'Explicit isolated test Host authorization is required')
assert.ok(origin && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Use a loopback test Host or SSH tunnel')
const directory = resolve('ui/dist'); checkProductionUi(directory)
let registration, handle, connections = 0
const sockets = [], states = [], frames = []
class Socket extends WebSocket {constructor(url) {super(url); sockets.push(this)}}
const location = {...Object.fromEntries(['origin','hostname'].map(key => [key, new URL(origin)[key]])), search: '?fixture=1'}
vm.runInNewContext(readFileSync(resolve(directory, 'plugins/@xharness/dsh-client-connection/client.js'), 'utf8'), {
  window: {__ModuleLoader__: {load(row) {registration = row}}}, location, fetch, WebSocket: Socket,
  console, URL, URLSearchParams, AbortController, AbortSignal, crypto: globalThis.crypto,
  setTimeout, clearTimeout, queueMicrotask, structuredClone,
})
registration.factory(name => {assert.ok(name in sharedVendors); return sharedVendors[name]}).apply({provide(_name, value) {handle = value}})
const value = response => {assert.equal(response.result.ok, true, JSON.stringify(response.result)); return response.result.value}
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50))}
  throw Error(`Timed out: ${label}`)
}
let sessionId
const loop = handle.start({onConnected() {connections++}, onStateChange(state) {states.push(state)}, onMuxEnvelope(frame) {frames.push(frame.payload)}}, {backoffBaseMs: 20, backoffMaxMs: 100, streamOpenTimeoutMs: 2000})
try {
  await until(() => connections === 1, 'initial connection')
  assert.ok(handle.hostDescription.getSnapshot()); assert.equal(sockets.length, 2)
  sessionId = value(await handle.api.sessions.create({})).sessionId
  assert.ok(value(await handle.api.sessions.list({})).items.some(row => row.sessionId === sessionId))
  value(await handle.api.sessions.prompt({sessionId, mode: 'queue', content: [{type: 'text', text: 'hold-first'}]}))
  await until(() => frames.some(frame => frame.type === 'session/event' && frame.sessionId === sessionId && frame.event.type === 'turn/start'), 'active first turn')
  value(await handle.api.sessions.prompt({sessionId, mode: 'queue', content: [{type: 'text', text: 'queued-second'}]}))
  await until(() => frames.some(frame => frame.type === 'session/queue' && frame.sessionId === sessionId && JSON.stringify(frame).includes('queued-second')), 'pending inbox snapshot')
  value(await handle.api.sessions.cancel({sessionId}))
  await until(async () => value(await handle.api.sessions.history({sessionId, maxMessages: 100})).events.some(row => row.event.type === 'assistant/message' && JSON.stringify(row.event.data).includes('Local provider completed: queued-second')), 'queued turn resumes after cancel')
  const before = value(await handle.api.sessions.history({sessionId, maxMessages: 100}))
  assert.ok(JSON.stringify(before).includes('hold-first'))
  assert.ok(JSON.stringify(before).includes('queued-second'))
  assert.ok(JSON.stringify(before).includes('cancelled'))
  for (const socket of sockets.slice(0, 2)) socket.close()
  await until(() => connections >= 2, 'reconnection after actual socket closure')
  assert.ok(states.includes('reconnecting')); assert.ok(handle.hostDescription.getSnapshot())
  const after = value(await handle.api.sessions.history({sessionId, maxMessages: 100}))
  assert.deepEqual(after.events.slice(0, before.events.length), before.events)
  const report = {realHost: true, fixtureQueryIgnored: true, localDeterministicProvider: true, sessionId, connectedGenerations: connections, historyEvents: after.events.length, queueCancelAndResume: true, historyStableAfterReconnect: true}
  console.log(JSON.stringify(report))
} finally {if (sessionId) await handle.api.sessions.cancel({sessionId}).catch(() => {}); loop.stop(); assert.equal(handle.hostDescription.getSnapshot(), undefined); for (const socket of sockets) socket.close()}
