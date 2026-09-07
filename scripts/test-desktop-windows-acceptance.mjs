import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { requireHostedWindows, validateRun, installerLocation, acceptanceFromPass } from './desktop-windows-acceptance.mjs'

const repo = '123123213weqw/x-harness-rs'
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REF: 'refs/heads/master',
  GITHUB_REPOSITORY: repo, XHARNESS_FRIENDS_RELEASE_REPOSITORY: repo }
requireHostedWindows(env, 'win32')
for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
  { GITHUB_REF: 'refs/pull/1/merge' }, { XHARNESS_FRIENDS_RELEASE_REPOSITORY: 'someone/fork' }]) {
  assert.throws(() => requireHostedWindows({ ...env, ...patch }, 'win32'))
}
assert.throws(() => requireHostedWindows(env, 'darwin'))
const plan = { tag: 'desktop-v0.2.6', version: '0.2.6', sha: 'a'.repeat(40), release_run_id: '123', release_run_attempt: '2',
  endpoint: `https://github.com/${repo}/releases/latest/download/latest.json` }
const run = { conclusion: 'success', status: 'completed', path: '.github/workflows/desktop-release.yml', event: 'push',
  head_branch: plan.tag, head_sha: plan.sha, id: 123, run_attempt: 2 }
validateRun(run, plan)
validateRun({ ...run, event: 'workflow_dispatch', head_branch: 'master' }, plan)
for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' },
  { path: '.github/workflows/friends-release.yml' }, { head_sha: 'b'.repeat(40) }, { head_branch: 'master' },
  { id: 124 }, { run_attempt: 1 }]) assert.throws(() => validateRun({ ...run, ...patch }, plan))
const name = 'XHarness_0.2.5_x64-setup.exe'
const url = `https://github.com/${repo}/releases/download/friends-v0.2.5/${name}`
assert.equal(installerLocation(repo, 'friends-v0.2.5', '0.2.5', url), name)
for (const bad of [url + '?token=x', url.replace('github.com', 'evil.test'), url.replace(name, '../' + name), url.replace('https:', 'http:')]) {
  assert.throws(() => installerLocation(repo, 'friends-v0.2.5', '0.2.5', bad))
}
assert.throws(() => installerLocation(repo, 'desktop-test-v0.2.5', '0.2.5', url))
const retained = ['providers.json', 'secrets/fake', 'workspace/sentinel'].map(name => ({ name, sha256: 'c'.repeat(64) }))
const cp = v => ({ version: v, journalSha256: 'd'.repeat(64), compiledKeySha256: 'e'.repeat(64), compiledEndpoint: plan.endpoint,
  status: { hostRunning: true, updaterConfigured: true }, retained })
const pass = { nativeDirectLatest: true, installCount: 1, confirmedInstall: true, corruptPackageRejected: true,
  upstreamEndpointAndKeyVerified: true, checkpoints: [cp('0.2.5'), cp('0.2.6')] }
const accept = value => acceptanceFromPass(plan, 'f'.repeat(64), '0'.repeat(64), value, {})
assert.equal(accept(pass).nativeUpdateAccepted, true)
for (const patch of [{ nativeDirectLatest: false }, { installCount: 0 }, { confirmedInstall: false },
  { corruptPackageRejected: false }, { upstreamEndpointAndKeyVerified: false }, { checkpoints: [cp('0.2.5')] }]) {
  assert.throws(() => accept({ ...pass, ...patch }))
}
for (const change of [cp => { cp.version = '0.2.7' }, cp => { cp.journalSha256 = '1'.repeat(64) },
  cp => { cp.compiledKeySha256 = '2'.repeat(64) }, cp => { cp.status.hostRunning = false },
  cp => { cp.compiledEndpoint = 'https://evil.test/latest.json' }, cp => { cp.retained = [] }]) {
  const copy = structuredClone(pass); change(copy.checkpoints[1]); assert.throws(() => accept(copy))
}
const workflow = readFileSync(new URL('../.github/workflows/desktop-windows-update-acceptance.yml', import.meta.url), 'utf8')
for (const forbidden of ['PRIVATE_KEY', 'contents: write', 'pull_request_target']) assert.ok(!workflow.includes(forbidden))
assert.ok(workflow.includes('refs/heads/master'))
assert.ok(workflow.includes('windows-migration-acceptance.ps1'))
assert.ok(workflow.includes('desktop-acceptance-windows-x86_64'))
const local = spawnSync(process.execPath, [fileURLToPath(new URL('./desktop-windows-acceptance.mjs', import.meta.url)), 'stage'], {
  env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8',
})
assert.notEqual(local.status, 0)
assert.match(local.stderr, /CI only/)
console.log('Unified Windows acceptance: 36 provenance, data preservation and isolation cases passed.')
