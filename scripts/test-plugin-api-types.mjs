import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { assertOwnedSource } from './owned-ui-type-policy.mjs'
const ui = resolve('ui'), require = createRequire(join(ui, 'package.json')), ts = require('typescript')
function compile(body) {
  const path = join(ui, 'src/plugin-api/type-contract-fixture.ts')
  const code = `import type { PluginCall, RpcResult, CatalogEntry, InstalledPlugin, PluginUpdate } from './contracts';\nexport async function fixture(call: PluginCall, entry: CatalogEntry, installed: InstalledPlugin, update: PluginUpdate, result: RpcResult<string>) { ${body} }`
  const options = { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
    typeRoots: [join(ui, 'node_modules/@types')], types: [], noEmit: true }
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host), exists = host.fileExists.bind(host)
  host.readFile = file => file === path ? code : read(file)
  host.fileExists = file => file === path || exists(file)
  const program = ts.createProgram([path], options, host)
  const source = program.getSourceFile(path)
  assert.ok(source)
  // Negative cases have genuine compiler errors, not suppressed diagnostics.
  assertOwnedSource(ts, source)
  return ts.getPreEmitDiagnostics(program)
}
for (const [name, code, expected] of [
  ['misspelled endpoint', `await call('plugins/catlog')`, 2345],
  ['missing mutation arguments', `await call('plugins/install')`, 2554],
  ['wrong mutation key', `await call('plugins/install', { pluginName: 'github' })`, 2353],
  ['unmerged refresh endpoint', `await call('plugins/refreshCatalog', { force: false })`, 2345],
  ['unmerged source preference endpoint', `await call('plugins/setSourcePreference', { preference: 'gitee' })`, 2345],
  ['mutation arguments on a read', `await call('plugins/catalog', { name: 'github' })`, 2322],
  ['unknown catalog scope', `await call('plugins/importCatalog', { content: '{}', scope: 'global' })`, 2322],
  ['snake-case wire field', 'void installed.mcp_enabled', 2551],
  ['guessed source field', 'void entry.url', 2339],
  ['guessed update field', 'void update.version', 2339],
  ['unnarrowed result', 'void result.value', 2339],
  ['endpoint response substitution', `const body = await call('plugins/catalog'); const wrong: InstalledPlugin = body; void wrong`, 2740],
]) test(`type contract rejects ${name}`, () => {
  const errors = compile(code)
  assert.ok(errors.some(error => error.code === expected), ts.formatDiagnostics(errors, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => ui, getNewLine: () => '\n',
  }))
  assert.ok(errors.every(error => error.file?.fileName === join(ui, 'src/plugin-api/type-contract-fixture.ts')))
})
test('valid endpoint responses retain their precise correlated field types without assertions', () => {
  assert.deepEqual(compile(`
    await call('plugins/catalog'); await call('plugins/updates');
    await call('plugins/enable', { name: 'github' }); await call('plugins/importCatalog', { content: '{}', scope: 'personal' });
    const catalog = await call('plugins/catalog'); const url: string | undefined = catalog.plugins[0]?.source.url;
    const removed = await call('plugins/uninstall', {name: 'github'}); const success: true = removed.ok;
    if (result.ok) { void result.value } else { void result.error.message }
    void url; void success;
  `), [])
})
