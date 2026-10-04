import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { compileSourceModules } from './build-source-modules.mjs'
import { exposeModuleUnit } from './fixtures/module-unit-scope.mjs'
const id = '@xharness/dsh-client-connection'
const source = compileSourceModules(new URL('../ui', import.meta.url).pathname, [{ id, source: 'src/modules/client-connection/index.ts' }]).get(id).bytes.toString()
function evaluate(unit, name, globals = {}) {
 let registration
 const location = { origin: 'http://fork.test', hostname: 'fork.test', search: '' }
 const context = { window: { location, __ModuleLoader__: { load: row => { registration = row } } }, location, console,
  AbortController, AbortSignal, URL, URLSearchParams, Date, Response, Headers, Request, crypto: globalThis.crypto,
  structuredClone, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, fetch, ...globals }
 vm.runInNewContext(exposeModuleUnit(source, 'client-connection', unit, name), context)
 return registration.factory(name => { throw Error('Unexpected external ' + name) })[name]
}
const hostSchema = evaluate('contracts/host/apiproxy/api/events.schema', 'hostFrameSchema')
const listSchema = evaluate('contracts/host/apiproxy/api/sessions.schema', 'sessionListValueSchema')
const summary = origin => ({ sessionId: 'child', parentSessionId: 'parent', blank: false, updatedAt: 1, running: false,
 ...origin === undefined ? {} : { origin } })
const added = origin => ({ type: 'host/session-added', sessionId: 'child', parentSessionId: 'parent', blank: false,
 ...origin === undefined ? {} : { origin } })
const json = x => JSON.parse(JSON.stringify(x))
const corpus = [undefined, 'subagent', 'fork', 'automation'].map(origin => ({ added: added(origin), list: { items: [summary(origin)] } }))
for (const path of [process.env.XHARNESS_FORK_WIRE_EXPORT, process.env.XHARNESS_AUTOMATION_WIRE_EXPORT]) {
 if (path) corpus.push(...JSON.parse(readFileSync(path, 'utf8')))
}

test('fork, automation, delegated child and old absent origin use the same strict lineage vocabulary in live and list decoders', () => {
 for (const item of corpus) {
  const event = hostSchema.parse(item.added), list = listSchema.parse(item.list)
  const child = list.items.find(row => row.sessionId === event.sessionId)
  assert.ok(child); assert.equal(event.origin, child.origin); assert.equal(event.parentSessionId, child.parentSessionId)
  assert.equal(event.blank, child.blank)
 }
 for (const origin of ['unknown', '', null, 1, {}]) {
  assert.equal(hostSchema.safeParse(added(origin)).success, false)
  assert.equal(listSchema.safeParse({ items: [summary(origin)] }).success, false)
 }
 assert.equal(hostSchema.safeParse({ ...added('fork'), blank: 'false' }).success, false)
 assert.equal(listSchema.safeParse({ items: [{ ...summary('fork'), sessionId: '' }] }).success, false)
})

test('production WebSocket and unary HTTP paths accept real lineage carriers, without fixture bypass', { timeout: 10000 }, async () => {
 let socket, list, malformed = false
 class Socket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1
  readyState = 0
  constructor(url) { super(); socket = this; this.url = String(url); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  emit(payload) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'server-request', rpcId: 'native-fork', method: payload.type, payload }) })) }
 }
 const Client = evaluate('web-api-client', 'WebApiClient', { WebSocket: Socket, fetch: async (_url, init) => {
  const request = JSON.parse(init.body); assert.equal(request.method, 'session.list')
  return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: malformed ? { items: [summary('invalid')] } : list } }), { headers: { 'content-type': 'application/json' } })
 } })
 for (const item of corpus) {
  const client = new Client(), abort = new AbortController(), iterator = client.events.host({}, abort.signal)[Symbol.asyncIterator]()
  try {
   const next = iterator.next(); socket.emit(item.added)
   const message = await next
   assert.deepEqual(json(message.value.payload), json(hostSchema.parse(item.added)))
   assert.ok(socket.url.endsWith('/api/events.host'))
   list = item.list
   const response = await client.sessions.list({})
   assert.equal(response.result.ok, true); assert.deepEqual(json(response.result.value), json(listSchema.parse(list)))
  } finally { abort.abort(); await iterator.return() }
 }
 malformed = true
 await assert.rejects(new Client().sessions.list({}), error => error.name === 'ZodError'
  && error.issues.some(issue => issue.path.join('.') === 'items.0.origin'))
})
