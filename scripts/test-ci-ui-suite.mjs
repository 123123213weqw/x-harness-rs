import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readPlan, select, partition, runEntries, root } from './ci-ui-suite.mjs'
import { receipt, verify } from './ci-ui-artifact.mjs'
import { assertUiGate, requiredUiJobs } from './ci-ui-gate.mjs'

const plan = readPlan()
const baselineFile = readFileSync(resolve(root, 'scripts/ci/ui-baseline.json'))
const baseline = JSON.parse(baselineFile)
const identity = entry => JSON.stringify([entry.argv, Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b))])
function counts(entries) {
  const map = new Map()
  for (const entry of entries) map.set(identity(entry), (map.get(identity(entry)) ?? 0) + 1)
  return map
}
const allSelected = () => [
  ...select(plan, { suite: 'build' }),
  ...['before', 'after'].flatMap(phase => select(plan, { suite: 'parity', phase })),
  ...Array.from({ length: 4 }, (_, shard) => select(plan, { suite: 'contract', shard, shards: 4 })).flat(),
  ...['chromium', 'webkit'].flatMap(browser => Array.from({ length: 4 }, (_, shard) => select(plan, { suite: 'browser', browser, shard, shards: 4 })).flat()),
]

test('frozen pre-shard command coverage includes every argv/env occurrence, even duplicates', () => {
  assert.equal(createHash('sha256').update(baselineFile).digest('hex'), '86dbadedb8cd632c6227cadd026b0261130d9c4ea93074995f37c1e2e8dfe3c6', 'Do not shrink the frozen coverage baseline')
  assert.equal(baseline.commands.length, 290)
  const actual = counts(allSelected())
  for (const [command, count] of counts(baseline.commands)) assert.ok((actual.get(command) ?? 0) >= count, `Lost coverage: ${command}`)
})
test('workflow partition executes each plan ID exactly once, no shard loss/duplication', () => {
  assert.deepEqual(allSelected().map(entry => entry.id).sort(), plan.entries.map(entry => entry.id).sort())
  assert.deepEqual(plan.entries.filter(entry => entry.suite === 'build').map(entry => entry.argv), select(plan, { suite: 'build' }).map(entry => entry.argv))
  for (const browser of ['chromium', 'webkit']) assert.ok(allSelected().some(entry => entry.env.UI_TEST_BROWSER === browser && entry.env.UI_TEST_IMPL === 'legacy'))
})
test('every plan script exists; environment variants and command arguments stay explicit', () => {
  for (const entry of plan.entries) for (const arg of entry.argv) if (arg.startsWith('scripts/')) assert.ok(existsSync(resolve(root, arg)), `${entry.id}: missing script ${arg}`)
  const noAnchor = plan.entries.filter(entry => entry.env.UI_TEST_NO_NATIVE_ANCHOR === '1')
  assert.deepEqual(noAnchor.map(entry => entry.env.UI_TEST_BROWSER).sort(), ['chromium', 'webkit'])
})
test('deterministic LPT partitions are balanced, ordered and do not mutate input', () => {
  const items = [9, 8, 7, 6, 5, 4, 3, 2].map((weight, index) => ({ id: `contract-${index}`, weight }))
  const before = structuredClone(items), buckets = partition(items, 4)
  assert.deepEqual(items, before)
  assert.deepEqual(buckets, partition(items, 4))
  assert.deepEqual(buckets.map(bucket => bucket.reduce((sum, item) => sum + item.weight, 0)), [11, 11, 11, 11])
})
test('invalid suite/browser/shard is not silently empty or skipped', () => {
  for (const options of [
    { suite: 'bogus' }, { suite: 'browser' }, { suite: 'contract', browser: 'webkit' },
    { suite: 'contract', shard: 4, shards: 4 }, { suite: 'contract', shard: -1 },
    { suite: 'build', shards: 2 }, { suite: 'contract', phase: 'before' },
  ]) assert.throws(() => select(plan, options))
})
test('required UI gate rejects failure, cancelled, skipped, unknown and missing dependencies', () => {
  const needs = Object.fromEntries(requiredUiJobs.map(name => [name, { result: 'success' }]))
  assert.doesNotThrow(() => assertUiGate(needs))
  for (const name of requiredUiJobs) for (const result of ['failure', 'cancelled', 'skipped', undefined]) assert.throws(() => assertUiGate({ ...needs, [name]: { result } }))
  assert.throws(() => assertUiGate({ ...needs, surprise: { result: 'success' } }))
  const missing = { ...needs }; delete missing['ui-browser']; assert.throws(() => assertUiGate(missing))
})
function temp() { return mkdtempSync(join(tmpdir(), 'xharness-ci-test-')) }
function command(id, code, suite = 'contract', env = {}) { return { id, suite, argv: ['node', '-e', code], env, weight: 1 } }
test('independent failures continue; real exit code, duration and final receipt survive', async () => {
  const cwd = temp(), report = join(cwd, 'timing.json')
  try {
    const result = await runEntries([
      command('contract-001', 'process.exit(7)'),
      command('contract-002', "require('node:fs').writeFileSync('next', 'yes')"),
    ], { cwd, report, stdio: 'ignore' })
    assert.equal(result.ok, false); assert.equal(result.results[0].exitCode, 7)
    assert.equal(result.results[1].ok, true); assert.ok(existsSync(join(cwd, 'next')))
    assert.ok(result.results.every(row => row.durationMs >= 0))
    assert.deepEqual(JSON.parse(readFileSync(report)), result)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
test('failed committed build check blocks subsequent repair/build commands', async () => {
  const cwd = temp()
  try {
    const result = await runEntries([command('build-001', 'process.exit(3)', 'build'), command('build-002', "require('node:fs').writeFileSync('repaired', 'bad')", 'build')], { cwd, report: join(cwd, 'timing.json'), stdio: 'ignore' })
    assert.equal(result.ok, false); assert.equal(result.results.length, 1); assert.equal(existsSync(join(cwd, 'repaired')), false)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
test('ambient implementation/browser flags are cleared, explicit entry flags restored', async () => {
  const cwd = temp()
  try {
    const script = "require('node:assert/strict').deepEqual([process.env.UI_TEST_BROWSER, process.env.UI_TEST_IMPL, process.env.UI_TEST_NO_NATIVE_ANCHOR], ['webkit', undefined, undefined])"
    const result = await runEntries([command('contract-001', script, 'contract', { UI_TEST_BROWSER: 'webkit' })], { cwd, report: join(cwd, 'timing.json'), stdio: 'ignore', env: { ...process.env, UI_TEST_IMPL: 'legacy', UI_TEST_BROWSER: 'chromium', UI_TEST_NO_NATIVE_ANCHOR: '1' } })
    assert.equal(result.ok, true)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
test('timeout and missing executable are failures and still produce receipts', async () => {
  const cwd = temp()
  try {
    const result = await runEntries([
      command('contract-001', 'setInterval(() => {}, 1000)'),
      { ...command('contract-002', ''), argv: ['xharness-does-not-exist'] },
    ], { cwd, report: join(cwd, 'timing.json'), stdio: 'ignore', timeoutMs: 100 })
    assert.equal(result.ok, false); assert.equal(result.results[0].timedOut, true)
    assert.match(result.results[1].error, /ENOENT/); assert.equal(result.results[1].ok, false)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
test('SIGTERM cancels the shard, kills running descendants, and leaves a checkpoint', { skip: process.platform === 'win32' }, async () => {
  const cwd = temp(), report = join(cwd, 'timing.json')
  try {
    const grandchild = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('grandchild-ready', 'ready'); setInterval(() => {}, 1000)"
    const child = `const p = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'}); const wait = setInterval(() => { if(require('node:fs').existsSync('grandchild-ready')) {require('node:fs').writeFileSync('ready', String(p.pid)); clearInterval(wait)} }, 10); setInterval(() => {}, 1000)`
    writeFileSync(join(cwd, 'run.mjs'), `import {runEntries} from ${JSON.stringify(new URL('./ci-ui-suite.mjs', import.meta.url).href)}; const r = await runEntries(${JSON.stringify([command('contract-001', child), command('contract-002', 'process.exit(0)')])}, {cwd: ${JSON.stringify(cwd)}, report: ${JSON.stringify(report)}, stdio:'ignore'}); process.exitCode = r.cancelled ? 130 : 0`)
    const proc = spawn(process.execPath, [join(cwd, 'run.mjs')], { stdio: 'ignore' })
    const closed = new Promise((res, rej) => { proc.once('error', rej); proc.once('close', res) })
    for (let tries = 0; !existsSync(join(cwd, 'ready')); tries++) { assert.ok(tries < 100, 'fixture did not start'); await new Promise(res => setTimeout(res, 20)) }
    const pid = Number(readFileSync(join(cwd, 'ready')))
    proc.kill('SIGTERM'); assert.equal(await closed, 130)
    const saved = JSON.parse(readFileSync(report)); assert.equal(saved.cancelled, true); assert.equal(saved.ok, false); assert.equal(saved.results.length, 1)
    // Reparented killed processes can briefly be zombies on Linux; they cannot do work.
    let running = true
    for (let tries = 0; tries < 100 && running; tries++) {
      try { process.kill(pid, 0); if (existsSync(`/proc/${pid}/stat`) && readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')) running = false }
      catch (error) { assert.equal(error.code, 'ESRCH'); running = false }
      if (running) await new Promise(res => setTimeout(res, 20))
    }
    assert.equal(running, false, 'orphan test descendant left running')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
test('build reuse validates exact SHA, plan, generated bytes, added and deleted files', () => {
  const cwd = temp(), sha = 'a'.repeat(40)
  try {
    mkdirSync(join(cwd, 'ui/dist'), { recursive: true }); mkdirSync(join(cwd, 'scripts/ci'), { recursive: true })
    const file = join(cwd, 'ui/dist/index.html'), planFile = join(cwd, 'scripts/ci/ui-plan.json')
    writeFileSync(file, 'good'); writeFileSync(planFile, 'plan')
    const saved = receipt(cwd, sha); assert.doesNotThrow(() => verify(cwd, saved, sha))
    assert.throws(() => verify(cwd, saved, 'b'.repeat(40)))
    writeFileSync(file, 'evil'); assert.throws(() => verify(cwd, saved, sha)); writeFileSync(file, 'good')
    writeFileSync(planFile, 'changed'); assert.throws(() => verify(cwd, saved, sha)); writeFileSync(planFile, 'plan')
    writeFileSync(join(cwd, 'ui/dist/extra'), 'added'); assert.throws(() => verify(cwd, saved, sha)); rmSync(join(cwd, 'ui/dist/extra'))
    rmSync(file); assert.throws(() => verify(cwd, saved, sha))
    assert.throws(() => receipt(cwd, 'short'))
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('artifact verification rejects symlink files and root directories', { skip: process.platform === 'win32' }, () => {
  const cwd = temp(), sha = 'a'.repeat(40)
  try {
    mkdirSync(join(cwd, 'ui/dist'), { recursive: true }); mkdirSync(join(cwd, 'scripts/ci'), { recursive: true })
    writeFileSync(join(cwd, 'scripts/ci/ui-plan.json'), 'plan'); writeFileSync(join(cwd, 'outside'), 'outside')
    symlinkSync(join(cwd, 'outside'), join(cwd, 'ui/dist/link')); assert.throws(() => receipt(cwd, sha), /symlink/)
    rmSync(join(cwd, 'ui/dist'), { recursive: true }); mkdirSync(join(cwd, 'other'))
    symlinkSync(join(cwd, 'other'), join(cwd, 'ui/dist')); assert.throws(() => receipt(cwd, sha), /real directory/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
test('isolated browser toolchain lock retains exact versions and registry integrity', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'scripts/ui-test-deps/package.json')))
  const lock = JSON.parse(readFileSync(resolve(root, 'scripts/ui-test-deps/package-lock.json')))
  assert.deepEqual(pkg.dependencies, { playwright: '1.61.1', react: '18.3.1', 'react-dom': '18.3.1' })
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies)
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.equal(lock.packages['node_modules/' + name].version, version)
  for (const [name, record] of Object.entries(lock.packages)) if (name) {
    assert.ok(record.resolved.startsWith('https://registry.npmjs.org/')); assert.match(record.integrity, /^sha512-/)
  }
})
