import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const requiredUiJobs = ['ui-build', 'ui-contracts', 'ui-browser', 'ui-parity']
export function assertUiGate(needs) {
  assert.deepEqual(Object.keys(needs).sort(), [...requiredUiJobs].sort(), 'Required UI dependency set changed')
  for (const name of requiredUiJobs) assert.equal(needs[name]?.result, 'success', `${name} must succeed (failure, skipped and cancelled are not success)`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertUiGate(JSON.parse(process.env.UI_CI_NEEDS)); console.log('All UI build, contract, two-engine and parity gates succeeded')
}
