// Real workflow dependency results only: never synthesize a successful status.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const requiredCiJobs = [
  'architecture-freeze', 'release-checkpoints', 'unix-update-rehearsal',
  'update-channel-contract', 'compaction-evaluator-contract', 'cloud-offline-guards',
  'context-layout', 'ui-build', 'ui-contracts', 'ui-browser', 'ui-parity',
  'rust-linux', 'rust-windows', 'macos-fixed-signing-contract',
  'rust-macos-arm64', 'desktop-linux',
]

export function assertCiGate(needs, event, ref) {
  assert.ok(needs && typeof needs === 'object' && !Array.isArray(needs), 'Missing CI dependency results')
  assert.deepEqual(Object.keys(needs).sort(), [...requiredCiJobs].sort(), 'Complete CI dependency set required')
  const masterPush = event === 'push' && ref === 'refs/heads/master'
  assert.ok(masterPush || event === 'pull_request' || event === 'workflow_dispatch', 'Unexpected CI trigger')
  for (const name of requiredCiJobs) {
    // This exact job is explicitly push/master-only. Skipping any other job,
    // or skipping this job on master, must never yield a green aggregate.
    const expected = name === 'unix-update-rehearsal' && !masterPush ? 'skipped' : 'success'
    assert.equal(needs[name]?.result, expected, `${name} must be ${expected}; failure/cancelled/missing/unknown is not success`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertCiGate(JSON.parse(process.env.CI_NEEDS), process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF)
  console.log('Every applicable CI workflow dependency succeeded; only the declared master-only rehearsal may be skipped outside a master push')
}
