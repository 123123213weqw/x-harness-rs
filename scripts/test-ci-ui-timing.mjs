import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { calibrate, replay } from './ci-ui-timing.mjs'
import { readPlan, root } from './ci-ui-suite.mjs'

const entry = { id: 'browser-001', suite: 'browser', argv: ['node', 'test.mjs'], env: { UI_TEST_BROWSER: 'webkit' }, weight: 120 }
const row = { ...entry, durationMs: 1234, ok: true, exitCode: 0, timedOut: false }
const sample = results => ({ schemaVersion: 1, runId: '123', sourceSha: 'a'.repeat(40), results })

test('calibration changes weights only, rounds up, and does not mutate inputs', () => {
  const plan = { schemaVersion: 1, entries: [entry] }, before = structuredClone(plan)
  const result = calibrate(plan, sample([row]))
  assert.deepEqual(plan, before)
  assert.deepEqual(result.plan.entries, [{ ...entry, weight: 2 }])
  assert.deepEqual(result.used, [entry.id]); assert.deepEqual(result.ignored, [])
})
test('new commands and stale argv/env/IDs retain fallback rather than borrowing unrelated timings', () => {
  for (const changed of [{ argv: ['node', 'different.mjs'] }, { env: { UI_TEST_BROWSER: 'chromium' } }, { id: 'browser-999' }]) {
    const plan = { entries: [{ ...entry, ...changed }] }
    const result = calibrate(plan, sample([row]))
    assert.deepEqual(result.plan, plan); assert.deepEqual(result.used, [])
    assert.deepEqual(result.ignored, [row.id])
  }
})
test('duplicate, failed, timed-out, incomplete and invalid samples fail closed', () => {
  const plan = { entries: [entry] }
  assert.throws(() => calibrate(plan, sample([row, row])), /Duplicate/)
  for (const changed of [{ ok: false }, { ok: undefined }, { exitCode: 7 }, { timedOut: true }, { durationMs: 0 }, { durationMs: Infinity }, { durationMs: 1200001 }, { id: 'build-001' }, { env: null }]) {
    assert.throws(() => calibrate(plan, sample([{ ...row, ...changed }])))
  }
  for (const changed of [{ sourceSha: 'short' }, { runId: 'bad' }, { results: [] }, { schemaVersion: 2 }]) {
    assert.throws(() => calibrate(plan, { ...sample([row]), ...changed }))
  }
})
test('committed real-run calibration preserves commands, variants, order and frozen coverage', () => {
  const plan = readPlan()
  const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/ci/ui-timing-baseline.json')))
  const result = calibrate(plan, baseline)
  assert.deepEqual(result.plan, plan)
  const totals = replay(plan, baseline)
  // New/changed tests intentionally retain fallback weights until remeasured.
  // Integer-second weights can differ from summed milliseconds by several seconds.
  if (result.ignored.length === 0 && totals.every(lane => lane.unmeasured.length === 0)) {
    for (const lane of totals) assert.ok(Math.max(...lane.seconds) - Math.min(...lane.seconds) < 15, JSON.stringify(lane))
  }
  const previous = new Map(baseline.results.map(row => [row.id, row.previousWeight]))
  const oldPlan = { ...plan, entries: plan.entries.map(entry => ({ ...entry, weight: previous.get(entry.id) ?? entry.weight })) }
  // Recorded timings are a scheduling replay, not a claim that the new CI ran.
  if (result.ignored.length === 0 && totals.every(lane => lane.unmeasured.length === 0)) {
    replay(oldPlan, baseline).forEach((lane, i) => assert.ok(Math.max(...totals[i].seconds) < Math.max(...lane.seconds) * .9))
  }
})
