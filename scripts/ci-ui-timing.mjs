/** Offline calibration only. CI executes the committed deterministic plan. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { partition, readPlan, root } from './ci-ui-suite.mjs'

const identity = entry => JSON.stringify([entry.argv,
  Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b, 'en'))])

export function calibrate(plan, baseline) {
  assert.equal(baseline.schemaVersion, 1)
  assert.match(baseline.runId, /^[1-9]\d*$/)
  assert.match(baseline.sourceSha, /^[0-9a-f]{40}$/)
  assert.ok(Array.isArray(baseline.results) && baseline.results.length > 0)
  const samples = new Map()
  for (const row of baseline.results) {
    assert.match(row.id, /^(contract|browser)-\d+$/)
    assert.ok(!samples.has(row.id), `Duplicate timing ID: ${row.id}`)
    assert.ok(Array.isArray(row.argv) && row.argv.length > 1 && row.argv.every(arg => typeof arg === 'string'))
    assert.ok(row.env && typeof row.env === 'object' && !Array.isArray(row.env))
    assert.ok(Number.isFinite(row.durationMs) && row.durationMs > 0 && row.durationMs <= 1200000)
    assert.equal(row.ok, true, 'Failed/cancelled timings cannot tune the plan')
    assert.equal(row.exitCode, 0)
    assert.equal(row.timedOut, false)
    samples.set(row.id, row)
  }
  const used = new Set()
  const entries = plan.entries.map(entry => {
    const sample = samples.get(entry.id)
    // Changed/new tests keep their explicit fallback weights. A stale sample
    // never changes a different argv or browser/implementation variant.
    if (!sample || identity(sample) !== identity(entry)) return entry
    assert.ok(['contract', 'browser'].includes(entry.suite))
    used.add(entry.id)
    return { ...entry, weight: Math.max(1, Math.ceil(sample.durationMs / 1000)) }
  })
  return { plan: { ...plan, entries }, used: [...used],
    ignored: [...samples.keys()].filter(id => !used.has(id)) }
}

export function replay(plan, baseline) {
  const { used } = calibrate(plan, baseline)
  const samples = new Map(baseline.results.filter(row => used.includes(row.id)).map(row => [row.id, row.durationMs / 1000]))
  return ['contract', 'chromium', 'webkit'].map(lane => {
    const entries = plan.entries.filter(entry => lane === 'contract'
      ? entry.suite === 'contract'
      : entry.suite === 'browser' && (entry.env.UI_TEST_BROWSER ?? 'chromium') === lane)
    const buckets = partition(entries, 4)
    return { lane, seconds: buckets.map(bucket => Math.round(bucket.reduce((n, entry) => n + (samples.get(entry.id) ?? 0), 0))),
      unmeasured: entries.filter(entry => !samples.has(entry.id)).map(entry => entry.id) }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 3 && ['--write', '--check'].includes(process.argv[2]), 'Usage: node scripts/ci-ui-timing.mjs --write|--check')
  const plan = readPlan()
  const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/ci/ui-timing-baseline.json'), 'utf8'))
  const calibrated = calibrate(plan, baseline)
  console.log(JSON.stringify({ runId: baseline.runId, matched: calibrated.used.length,
    ignored: calibrated.ignored, historicalReplayOnly: true,
    before: replay(plan, baseline), after: replay(calibrated.plan, baseline) }, null, 2))
  if (process.argv[2] === '--write') {
    // Preserve the readable, one-entry-per-line format and all other fields.
    writeFileSync(resolve(root, 'scripts/ci/ui-plan.json'), '{\n  "schemaVersion": 1,\n  "entries": [\n'
      + calibrated.plan.entries.map(entry => '    ' + JSON.stringify(entry)).join(',\n') + '\n  ]\n}\n')
  } else assert.deepEqual(plan, calibrated.plan, 'Run ci-ui-timing.mjs --write to commit calibrated weights')
}
