// Consume actual Rust serde output, rather than a JS fixture assumed to match it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { copy, loadPluginApi } from './fixtures/load-plugin-api.mjs'

assert.ok(process.argv[2], 'usage: node scripts/test-plugin-wire-contract.mjs RUST_FIXTURE.json')
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
assert.equal(fixture.contract, 'plugin-center-v1')
const api = loadPluginApi()
for (const [type, fields] of Object.entries(api.WIRE_FIELDS)) {
  assert.deepEqual(Object.keys(fixture.types[type]).sort(), Object.keys(fields).sort(), `${type}: Rust serialized fields match checked TS declarations`)
}
const endpoints = new Set()
let native = 0, shared = 0, failures = 0
for (const { endpoint, result, producer } of fixture.calls) {
  endpoints.add(endpoint)
  if (producer) shared++; else native++
  if (result.ok) {
    assert.deepEqual(copy(api.decodeResponse(endpoint, result)), result.value, `${endpoint}: decoding actual serde reply is lossless`)
  } else {
    failures++
    assert.throws(() => api.decodeResponse(endpoint, result), error => error instanceof api.PluginRemoteError && error.code === result.error.code && error.message === result.error.message)
  }
}
assert.equal(endpoints.size, 11, 'all current merged-main plugin-center endpoint contracts covered')
assert.ok(native >= 12 && shared === 1 && failures === 2)
console.log(`plugin wire contract: ${native} native Host replies, ${shared} explicitly shared install DTO fixture; ${endpoints.size} endpoints, ${failures} error replies passed (no network install claimed)`)
