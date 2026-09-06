import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const source = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const js = source('./windows-migration-acceptance.mjs')
const ps = source('./windows-migration-acceptance.ps1')
const workflow = source('../.github/workflows/windows-migration-acceptance.yml')
for (const text of [js, ps]) {
  assert.ok(text.includes('github-hosted'))
  assert.ok(text.includes('GITHUB_ACTIONS'))
}
assert.ok(!workflow.includes('PRIVATE_KEY'))
assert.ok(!workflow.includes('contents: write'))
assert.ok(!workflow.includes('pull_request_target'))
assert.ok(!js.includes('ignoreHTTPSErrors'))
assert.ok(!js.includes('NODE_TLS_REJECT_UNAUTHORIZED'))
assert.ok(js.includes('confirmStop: false'))
assert.ok(js.includes('confirmStop: true'))
assert.ok(js.includes('PASS.json'))
assert.ok(js.includes('127.0.0.1'))
const result = spawnSync(process.execPath, [fileURLToPath(new URL('./windows-migration-acceptance.mjs', import.meta.url)), 'run'], {
  env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8',
})
assert.notEqual(result.status, 0)
assert.match(result.stderr, /CI only/)
console.log('Native migration guard: refuses local execution; no private keys, public writes or TLS bypass.')
