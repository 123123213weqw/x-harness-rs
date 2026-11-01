import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertCiGate, requiredCiJobs } from './ci-gate.mjs'

const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const needs = (master = false) => Object.fromEntries(requiredCiJobs.map(name => [name, {
  result: name === 'unix-update-rehearsal' && !master ? 'skipped' : 'success',
}]))

function assertWorkflowGate(input) {
  // Git's native Windows checkout uses CRLF; normalize only line terminators.
  const source = input.replace(/\r\n/g, '\n')
  const jobs = source.slice(source.indexOf('\njobs:\n'))
  const names = [...jobs.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1])
  assert.deepEqual(names.filter(name => name !== 'ci').sort(), [...requiredCiJobs].sort())
  const aggregate = jobs.split('\n  ci:\n')[1]?.split(/\n  [\w-]+:\n/)[0]
  assert.ok(aggregate)
  assert.ok(aggregate.includes("    name: ${{ github.event_name == 'workflow_dispatch' && 'CI / manual diagnostics' || 'CI' }}"), 'PR/master must publish CI; manual diagnostics must not impersonate PR admission')
  assert.match(aggregate, /^    if: \$\{\{ always\(\) \}\}$/m)
  const dependencies = aggregate.match(/^    needs: \[([^\]]+)\]$/m)?.[1].split(',').map(s => s.trim())
  assert.deepEqual(dependencies?.sort(), [...requiredCiJobs].sort())
  assert.ok(aggregate.includes('CI_NEEDS: ${{ toJSON(needs) }}'))
  assert.ok(aggregate.includes('node --test scripts/test-ci-gate.mjs'))
  assert.ok(aggregate.includes('node scripts/ci-gate.mjs'))
  assert.ok(!aggregate.includes('continue-on-error'))
  assert.ok(!aggregate.includes('|| true'))
  assert.ok(source.includes('node --test scripts/test-ci-gate.mjs'))
}

function assertRegressionEnrollment(input) {
  const source = input.replace(/\r\n/g, '\n')
  const windows = source.split('\n  rust-windows:\n')[1].split(/\n  [\w-]+:\n/)[0]
  assert.ok(windows.includes("python -B -m unittest scripts/regression/test_check_architecture.py scripts/regression/test_architecture_freeze.py\n          if ($LASTEXITCODE) { throw 'Architecture stabilization regression failed' }"))
  assert.ok(windows.indexOf('actions/setup-node@') < windows.indexOf('node --test scripts/test-ci-gate.mjs'))
  assert.ok(windows.includes('- name: Native Windows fail-closed CI aggregate regression\n        run: node --test scripts/test-ci-gate.mjs'))
  const ui = source.split('\n  ui-build:\n')[1].split(/\n  [\w-]+:\n/)[0]
  assert.ok(ui.includes('node --test scripts/test-ci-gate.mjs'))
}

test('literal CI check runs always and directly depends on every workflow job', () => {
  assertWorkflowGate(source)
})

test('early and native Windows regression enrollment preserves existing failure handling', () => {
  assertRegressionEnrollment(source)
})

test('LF and CRLF checkouts enforce the same workflow and native failure guards', () => {
  const lf = source.replace(/\r\n/g, '\n')
  for (const workflow of [lf, lf.replace(/\n/g, '\r\n')]) {
    assert.doesNotThrow(() => assertWorkflowGate(workflow))
    assert.doesNotThrow(() => assertRegressionEnrollment(workflow))
    assert.throws(() => assertWorkflowGate(workflow.replaceAll('    if: ${{ always() }}', '    if: ${{ success() }}')))
    assert.throws(() => assertRegressionEnrollment(workflow.replace("if ($LASTEXITCODE) { throw 'Architecture stabilization regression failed' }", '# missing native failure guard')))
  }
})

test('PR and manual runs accept only the explicit release-only skip', () => {
  for (const event of ['pull_request', 'workflow_dispatch']) {
    assert.doesNotThrow(() => assertCiGate(needs(), event, 'refs/pull/417/merge'))
    const changed = needs(); changed['unix-update-rehearsal'].result = 'success'
    assert.throws(() => assertCiGate(changed, event, 'refs/heads/master'))
  }
})

test('master push requires the native signed rehearsal to succeed too', () => {
  assert.doesNotThrow(() => assertCiGate(needs(true), 'push', 'refs/heads/master'))
  for (const result of ['skipped', 'failure', 'cancelled', 'timed_out', undefined, '']) {
    const changed = needs(true); changed['unix-update-rehearsal'].result = result
    assert.throws(() => assertCiGate(changed, 'push', 'refs/heads/master'))
  }
})

test('every applicable dependency fails closed for all non-success results', () => {
  for (const name of requiredCiJobs) for (const result of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'in_progress', undefined, '']) {
    const changed = needs(true); changed[name].result = result
    assert.throws(() => assertCiGate(changed, 'push', 'refs/heads/master'), `${name}: ${result}`)
  }
})

test('missing, extra, malformed and empty dependency sets cannot pass', () => {
  for (const name of requiredCiJobs) {
    const changed = needs(); delete changed[name]
    assert.throws(() => assertCiGate(changed, 'pull_request', 'refs/pull/417/merge'))
  }
  for (const changed of [null, [], {}, { ...needs(), surprise: { result: 'success' } }, { ...needs(), 'rust-windows': null }]) {
    assert.throws(() => assertCiGate(changed, 'pull_request', 'refs/pull/417/merge'))
  }
  for (const [event, ref] of [['push', 'refs/heads/other'], ['unknown', 'refs/heads/master'], ['', '']]) {
    assert.throws(() => assertCiGate(needs(true), event, ref))
  }
})

test('the production CLI exits nonzero instead of publishing success for invalid evidence', () => {
  for (const [json, ok] of [[JSON.stringify(needs()), true], ['{}', false], ['invalid JSON', false], ['', false], [JSON.stringify({ ...needs(), 'rust-windows': { result: 'skipped' } }), false]]) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-gate.mjs', import.meta.url))], {
      env: { ...process.env, CI_NEEDS: json, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/417/merge' }, encoding: 'utf8', timeout: 5000,
    })
    assert.equal(run.status === 0, ok)
    if (!ok) assert.ok(!run.stdout.includes('Every applicable CI workflow dependency succeeded'))
  }
})
