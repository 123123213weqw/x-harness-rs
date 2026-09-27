import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { patchStartupCatalogRefresh } from './patch-startup-catalog-refresh.mjs'

const runtime = readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-runtime/client.js', import.meta.url))
const connection = readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-connection/client.js', import.meta.url), 'utf8')
const graph = JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json', import.meta.url), 'utf8'))
const html = readFileSync(new URL('../ui/dist/index.html', import.meta.url), 'utf8')
const source = runtime.toString('utf8')
const marker = 'if (frame.event === "xharness/catalog-updated") {'
assert.equal(source.split(marker).length, 2, 'catalogue refresh hook must exist exactly once')
assert.ok(source.includes('if (this.listInflight !== null) await this.listInflight;'), 'a batch racing initial list must replay after the in-flight baseline')
assert.equal(source.includes('case "host/session-catalog-batch"'), false, 'do not emit an unregistered wire type')
assert.ok(connection.includes('type: literal("host/remote-event")'), 'existing validated Host frame carries refresh')
assert.deepEqual(patchStartupCatalogRefresh(runtime), runtime, 'rebuild patch must be idempotent')
const entry = graph.entries.find(row => row.id === '@xharness/dsh-client-runtime')
assert.ok(entry)
assert.equal(entry.rev, createHash('sha256').update(runtime).digest('hex').slice(0, 16))
assert.ok(html.includes(entry.url), 'HTML preload must use the current immutable revision')
const managerStart = source.indexOf('handleHostEnvelope(envelope) {', source.indexOf('refreshList() {'))
const caseStart = source.indexOf('case "host/remote-event":', managerStart)
const caseEnd = source.indexOf('case "host/session-added":', caseStart)
assert.ok(managerStart !== -1 && caseStart !== -1 && caseEnd !== -1)
const actualCase = source.slice(caseStart, caseEnd)
const onFrame = new Function('frame', `switch (frame.type) { ${actualCase} }`)
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const initial = deferred()
const manager = {
  listInflight: initial.promise,
  refreshes: 0,
  refreshList() { this.refreshes += 1; return Promise.resolve() },
}
const frame = { type: 'host/remote-event', event: 'xharness/catalog-updated' }
onFrame.call(manager, frame)
onFrame.call(manager, frame)
assert.equal(manager.refreshes, 0, 'catalogue must not reuse a stale in-flight list baseline')
initial.resolve()
await new Promise(resolve => setImmediate(resolve))
assert.equal(manager.refreshes, 1, 'multiple discovery batches coalesce after the initial request')
const firstRefresh = deferred()
manager.refreshList = () => { manager.refreshes += 1; return manager.refreshes === 2 ? firstRefresh.promise : Promise.resolve() }
onFrame.call(manager, frame)
await new Promise(resolve => setImmediate(resolve))
onFrame.call(manager, frame)
firstRefresh.resolve()
await new Promise(resolve => setImmediate(resolve))
assert.equal(manager.refreshes, 3, 'a batch arriving during refresh must trigger a final replay')
console.log('startup catalogue UI refresh: PASS')
