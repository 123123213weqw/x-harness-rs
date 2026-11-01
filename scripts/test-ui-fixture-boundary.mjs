import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve, join} from 'node:path'
import vm from 'node:vm'
import {exposeConnection} from './connection-artifact-test.mjs'
import {fixtureUiRoot} from './fixtures/ui-fixture-build.mjs'
import {compileSourceModules} from './build-source-modules.mjs'
import {sharedVendors} from './fixtures/shared-source-vendors.mjs'
import {checkProductionUi} from './check-production-ui.mjs'
import {assertProductionSources, moduleRowsForVariant, CONNECTION_ID, FIXTURE_CONNECTION} from './ui-build-variant.mjs'
import {OUTPUT_MARKER, sha256, treeHashes} from './ui-build-contract.mjs'
const root = resolve('.'), ui = join(root, 'ui')
const manifest = JSON.parse(readFileSync(join(ui, 'modules.json'), 'utf8'))
const production = compileSourceModules(ui, manifest.modules.filter(row => row.id === CONNECTION_ID)).get(CONNECTION_ID)
function evaluate(search, calls) {
  let registration, handle
  const location = {origin: 'https://host.test', hostname: 'host.test', search}
  vm.runInNewContext(production.bytes.toString(), {window: {__ModuleLoader__: {load(row) {registration = row}}}, location,
    console, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout, queueMicrotask,
    crypto: globalThis.crypto, fetch: async (url, init) => {
      const request = JSON.parse(init.body); calls.push({url: String(url), request})
      return {ok: true, json: async () => ({type: 'server-response', rpcId: request.rpcId, result: {ok: true,
        value: {version: 'real', cwd: '/real', attachedSessions: 0, home: '/home/real', canOpenPath: false}}})}
    }})
  registration.factory(name => {assert.ok(name in sharedVendors); return sharedVendors[name]}).apply({provide(_name, value) {handle = value}})
  return handle
}
test('production import closure and output contain no fixture transport or conversations', () => {
  assertProductionSources(production.sources)
  assert.doesNotMatch(production.bytes.toString(), /FixtureApiClient|fx-alpha|fixture-entry/)
  assert.ok(production.sources.includes('src/modules/client-connection/install.ts'))
  assert.ok(production.sources.includes('src/modules/client-connection/web-api-client.ts'))
  checkProductionUi(join(ui, 'dist'))
})
test('query flags cannot replace the production Host transport', async () => {
  for (const search of ['', '?fixture', '?fixture=1', '?fixture=0&demo=true']) {
    const calls = [], handle = evaluate(search, calls)
    const response = await handle.api.host.describe({})
    assert.equal(response.result.value.version, 'real')
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/api\/host.describe$/)
    assert.equal(calls[0].request.method, 'host.describe')
  }
})
test('only the entry source changes; IDs, injection, order and other modules remain identical', () => {
  const rows = moduleRowsForVariant(manifest.modules, 'fixture')
  assert.deepEqual(rows.map(row => row.id), manifest.modules.map(row => row.id))
  assert.equal(rows.find(row => row.id === CONNECTION_ID).source, FIXTURE_CONNECTION)
  for (let i = 0; i < rows.length; i++) assert.deepEqual(rows[i], rows[i].id === CONNECTION_ID ? {...manifest.modules[i], source: FIXTURE_CONNECTION} : manifest.modules[i])
  assert.throws(() => moduleRowsForVariant(rows, 'production'), /production connection/)
  assert.throws(() => moduleRowsForVariant(manifest.modules, 'unknown'), /Unknown/)
})
test('production compiler rejects fixture entry and transitive imports before emission', () => {
  assert.throws(() => compileSourceModules(ui, [{id: CONNECTION_ID, source: FIXTURE_CONNECTION}]), /forbidden in production/)
  const path = join(ui, 'src/modules/client-connection/boundary-probe.ts')
  try {
    writeFileSync(path, "import './fixture'\nexport const probe = true\n", {flag: 'wx'})
    assert.throws(() => compileSourceModules(ui, [{id: 'boundary-probe', source: 'src/modules/client-connection/boundary-probe.ts'}]), /fixture.ts/)
  } finally {rmSync(path, {force: true})}
})
test('fixture build cannot overwrite production output, including aliased paths', () => {
  const before = treeHashes(join(ui, 'dist'))
  for (const args of [[], ['--out-dir', join(ui, 'dist')], ['--out-dir', join(ui, 'src')]]) {
    const result = spawnSync(process.execPath, ['scripts/assemble-static-ui.mjs', '--variant', 'fixture', ...args], {encoding: 'utf8'})
    assert.notEqual(result.status, 0)
  }
  assert.deepEqual(treeHashes(join(ui, 'dist')), before)
})
test('packaging rejects fixture or missing provenance, stale hashes and injected fixture bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xharness-packaging-boundary-'))
  try {
    const marker = {schemaVersion: 1, builder: 'xharness-self-contained-ui', variant: 'production', moduleSources: {[CONNECTION_ID]: ['src/modules/client-connection/index.ts']}}
    const write = (metadata, code) => {
      writeFileSync(join(dir, OUTPUT_MARKER), JSON.stringify(metadata)); writeFileSync(join(dir, 'client.js'), code)
      const files = Object.fromEntries([OUTPUT_MARKER, 'client.js'].map(path => [path, {sha256: sha256(readFileSync(join(dir, path)))}]))
      writeFileSync(join(dir, 'asset-manifest.json'), JSON.stringify({schemaVersion: 1, files}))
    }
    write(marker, 'real'); checkProductionUi(dir)
    write({...marker, variant: 'fixture'}, 'real'); assert.throws(() => checkProductionUi(dir), /production UI/)
    write({...marker, variant: undefined}, 'real'); assert.throws(() => checkProductionUi(dir), /production UI/)
    write(marker, 'class FixtureApiClient {}'); assert.throws(() => checkProductionUi(dir), /Fixture code/)
    write(marker, 'real'); writeFileSync(join(dir, 'client.js'), 'changed'); assert.throws(() => checkProductionUi(dir), /hash mismatch/)
    write({...marker, moduleSources: {[CONNECTION_ID]: ['src/modules/client-connection/index.ts', 'src/modules/client-connection/fixture.ts']}}, 'real')
    assert.throws(() => checkProductionUi(dir), /forbidden/)
    const config = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'))
    assert.equal(config.build.beforeBuildCommand, 'node ../../scripts/check-production-ui.mjs')
    assert.match(readFileSync('scripts/ci-ui-artifact.mjs', 'utf8'), /checkProductionUi\(resolve\(root, 'ui\/dist'\)\)/)
  } finally {rmSync(dir, {recursive: true, force: true})}
})

test('explicit fixture output preserves every other production module and never modifies release assets', () => {
  const before = treeHashes(join(ui, 'dist'))
  const fixture = fixtureUiRoot()
  const metadata = JSON.parse(readFileSync(join(fixture, OUTPUT_MARKER), 'utf8'))
  assert.equal(metadata.variant, 'fixture')
  assert.ok(metadata.moduleSources[CONNECTION_ID].includes(FIXTURE_CONNECTION))
  assert.throws(() => checkProductionUi(fixture), /production UI build/)
  for (const row of manifest.modules) {
    const path = `plugins/${row.id}/client.js`
    const original = readFileSync(join(ui, 'dist', path)), preview = readFileSync(join(fixture, path))
    if (row.id === CONNECTION_ID) assert.notDeepEqual(preview, original)
    else assert.deepEqual(preview, original, row.id)
  }
  assert.deepEqual(treeHashes(join(ui, 'dist')), before)
})

test('acceptance seams cannot silently substitute fixture code for a production contract', () => {
  const fixture = readFileSync(join(fixtureUiRoot(), `plugins/${CONNECTION_ID}/client.js`), 'utf8')
  assert.throws(() => exposeConnection(production.bytes.toString(), ['contextPressureOf']), /explicit fixture build/)
  assert.throws(() => exposeConnection(fixture, ['sessionModelsValueSchema']), /entry must match/)
  assert.throws(() => exposeConnection(production.bytes.toString(), ['sessionModelsValueSchema'], {variant: 'fixture'}), /entry must match/)
  assert.throws(() => exposeConnection(fixture, ['contextPressureOf'], {variant: 'invalid'}), /Unknown/)
  const exposed = exposeConnection(fixture, ['contextPressureOf'], {variant: 'fixture'})
  let registration
  vm.runInNewContext(exposed, {window: {__ModuleLoader__: {load(row) {registration = row}}}, console, URL, AbortController, setTimeout, clearTimeout})
  const api = registration.factory(name => {assert.ok(name in sharedVendors); return sharedVendors[name]})
  assert.equal(typeof api.contextPressureOf, 'function', 'the explicit fixture seam retains its real lexical reducer')
})
