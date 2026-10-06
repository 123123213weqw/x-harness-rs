/** UI-only deterministic shards. Test processes remain isolated and sequential within a shard. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../', import.meta.url))
export function readPlan(path = resolve(root, 'scripts/ci/ui-plan.json')) {
  const plan = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(plan.schemaVersion, 1)
  assert.ok(Array.isArray(plan.entries) && plan.entries.length > 0)
  const ids = new Set()
  for (const entry of plan.entries) {
    assert.match(entry.id, /^[a-z]+-\d+$/)
    assert.ok(!ids.has(entry.id), `Duplicate test ID: ${entry.id}`); ids.add(entry.id)
    assert.ok(['build', 'contract', 'browser', 'parity'].includes(entry.suite))
    assert.ok(Array.isArray(entry.argv) && entry.argv.length > 1)
    assert.ok(['node', 'npm', 'python3'].includes(entry.argv[0]))
    assert.ok(entry.argv.every(arg => typeof arg === 'string' && !/[\x00\r\n$]/.test(arg)))
    assert.ok(Number.isFinite(entry.weight) && entry.weight > 0)
    assert.ok(entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env))
    for (const [key, value] of Object.entries(entry.env)) {
      assert.ok(['UI_TEST_BROWSER', 'UI_TEST_IMPL', 'UI_TEST_NO_NATIVE_ANCHOR'].includes(key))
      assert.ok(typeof value === 'string')
    }
    if (entry.env.UI_TEST_BROWSER) assert.ok(['chromium', 'webkit'].includes(entry.env.UI_TEST_BROWSER))
    if (entry.env.UI_TEST_IMPL) assert.ok(['source', 'legacy'].includes(entry.env.UI_TEST_IMPL))
    if (entry.suite === 'parity') assert.ok(['before', 'after'].includes(entry.phase))
  }
  return plan
}

export function partition(entries, count) {
  assert.ok(Number.isInteger(count) && count > 0 && count <= 32, 'Invalid shard count')
  const buckets = Array.from({ length: count }, () => ({ weight: 0, entries: [] }))
  // Longest-processing-time first; stable lexical tie-breaks, no runtime/random dependencies.
  for (const entry of [...entries].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id, 'en'))) {
    const bucket = buckets.reduce((best, next) => next.weight < best.weight ? next : best)
    bucket.entries.push(entry); bucket.weight += entry.weight
  }
  // Preserve test ordering inside each isolated worker; only partition membership changes.
  const order = new Map(entries.map((entry, index) => [entry.id, index]))
  return buckets.map(bucket => bucket.entries.sort((a, b) => order.get(a.id) - order.get(b.id)))
}

export function select(plan, { suite, browser, phase, shard = 0, shards = 1 }) {
  assert.ok(['build', 'contract', 'browser', 'parity'].includes(suite), 'Unknown suite')
  if (suite === 'browser') assert.ok(['chromium', 'webkit'].includes(browser), 'Browser is required')
  else assert.equal(browser, undefined, 'Only browser suite takes --browser')
  if (phase) assert.ok(suite === 'parity' && ['before', 'after'].includes(phase), 'Invalid phase')
  assert.ok(Number.isInteger(shard) && shard >= 0 && shard < shards, 'Invalid shard index')
  const entries = plan.entries.filter(entry => entry.suite === suite
    && (!browser || (entry.env.UI_TEST_BROWSER ?? 'chromium') === browser)
    && (!phase || entry.phase === phase))
  assert.ok(entries.length > 0, 'Empty suite')
  if (suite === 'build' || suite === 'parity') assert.equal(shards, 1, 'Ordered gates must not be sharded')
  const result = partition(entries, shards)[shard]
  assert.ok(result.length > 0, 'Empty shard')
  return result
}

function save(path, receipt) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + `.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(receipt, null, 2) + '\n'); renameSync(temp, path)
}
function terminate(child, signal) {
  if (!child.pid) return // Spawn errors do not create a process group.
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}
export async function runEntries(entries, { cwd = root, report, timeoutMs = 20 * 60 * 1000, env = process.env, stdio = 'inherit' }) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Invalid test timeout')
  const receipt = { schemaVersion: 1, sourceSha: env.GITHUB_SHA ?? null, startedAt: new Date().toISOString(), results: [], cancelled: false }
  let current, cancelled = false, killTimer
  const stop = () => {
    cancelled = true; receipt.cancelled = true
    if (current) { terminate(current, 'SIGTERM'); killTimer ??= setTimeout(() => terminate(current, 'SIGKILL'), 3000) }
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    save(report, receipt)
    for (const entry of entries) {
      if (cancelled) break
      console.log(`::group::${entry.id}: ${entry.argv.join(' ')} ${JSON.stringify(entry.env)}`)
      const start = performance.now()
      let timedOut = false
      const outcome = await new Promise(resolveOutcome => {
        // Disallow ambient browser/implementation selection leaking into unrelated tests.
        const cleanEnv = { ...env }
        for (const key of ['UI_TEST_BROWSER', 'UI_TEST_IMPL', 'UI_TEST_NO_NATIVE_ANCHOR']) delete cleanEnv[key]
        const child = spawn(entry.argv[0], entry.argv.slice(1), { cwd, env: { ...cleanEnv, ...entry.env }, shell: false, detached: process.platform !== 'win32', stdio })
        current = child
        let settled = false
        const finish = result => {
          if (settled) return; settled = true
          if (timedOut || cancelled) terminate(child, 'SIGKILL')
          clearTimeout(timer); clearTimeout(killTimer); killTimer = undefined; current = undefined
          resolveOutcome(result)
        }
        const timer = setTimeout(() => {
          timedOut = true; terminate(child, 'SIGTERM')
          killTimer ??= setTimeout(() => terminate(child, 'SIGKILL'), 3000)
        }, timeoutMs)
        child.on('error', error => finish({ exitCode: null, signal: null, error: error.message }))
        child.on('close', (exitCode, signal) => finish({ exitCode, signal }))
      })
      const result = { id: entry.id, argv: entry.argv, env: entry.env, durationMs: Math.round(performance.now() - start), ...outcome, timedOut }
      result.ok = outcome.exitCode === 0 && !timedOut && !cancelled && !outcome.error
      receipt.results.push(result); save(report, receipt)
      console.log(`::endgroup::\n${result.ok ? 'PASS' : 'FAIL'} ${entry.id} ${(result.durationMs / 1000).toFixed(1)}s`)
      // Fail closed but continue collecting independent failures. Build must never repair a stale bundle after a failed --check.
      if (!result.ok && entry.suite === 'build') break
    }
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop)
    clearTimeout(killTimer)
    receipt.finishedAt = new Date().toISOString(); save(report, receipt)
  }
  receipt.ok = !cancelled && receipt.results.length === entries.length && receipt.results.every(result => result.ok)
  save(report, receipt)
  return receipt
}

function options(args) {
  const out = { shard: 0, shards: 1, list: false }
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '')
    if (key === 'list') { out.list = true; continue }
    assert.ok(['suite', 'browser', 'phase', 'shard', 'shards', 'report', 'timeout-ms'].includes(key) && args[i].startsWith('--') && i + 1 < args.length, `Unknown/missing option: ${args[i]}`)
    out[key === 'timeout-ms' ? 'timeoutMs' : key] = ['shard', 'shards', 'timeout-ms'].includes(key) ? Number(args[++i]) : args[++i]
  }
  return out
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2)), entries = select(readPlan(), opts)
  const name = [opts.suite, opts.browser, opts.phase, opts.shard].filter(v => v !== undefined).join('-')
  if (opts.list) console.log(JSON.stringify(entries, null, 2))
  else {
    const receipt = await runEntries(entries, { ...opts, report: opts.report ?? resolve(root, `dist/ci-ui-timings/${name}.json`) })
    if (process.env.GITHUB_STEP_SUMMARY) {
      const lines = [`### UI ${name}: ${receipt.ok ? 'passed' : receipt.cancelled ? 'cancelled' : 'failed'}`, '', '| Test | Seconds | Exit | Status |', '| --- | ---: | ---: | --- |',
        ...receipt.results.map(result => `| ${result.id} | ${(result.durationMs / 1000).toFixed(1)} | ${result.exitCode ?? result.signal ?? 'spawn error'} | ${result.ok ? 'pass' : result.timedOut ? 'timeout' : 'fail'} |`), '']
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
    }
    process.exitCode = receipt.cancelled ? 130 : receipt.ok ? 0 : 1
  }
}
