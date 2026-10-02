import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { copy, loadPluginApi } from './fixtures/load-plugin-api.mjs'

const api = loadPluginApi()
test('strict checking covers owned TS pages and boundaries; npm packages are build-only', () => {
  const config = JSON.parse(readFileSync('ui/tsconfig.json', 'utf8'))
  for (const key of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noEmitOnError']) assert.equal(config.compilerOptions[key], true)
  assert.equal(config.compilerOptions.allowJs, false)
  assert.equal(config.compilerOptions.checkJs, false)
  assert.ok(config.include.includes('src/plugin-api/**/*.ts'))
  const modules = JSON.parse(readFileSync('ui/modules.json', 'utf8'))
  const hub = modules.modules.find(row => row.id === '@xlang/xharness-client-ui-plugin-hub')
  assert.equal(hub.kind, 'source-module')
  assert.equal(hub.source, 'src/modules/plugin-hub/index.tsx')
  const sourceBuilder = readFileSync('scripts/build-source-modules.mjs', 'utf8')
  assert.match(sourceBuilder, /getPreEmitDiagnostics/)
  assert.match(sourceBuilder, /assertOwnedSource/)
  assert.match(readFileSync('scripts/build-plugin-api.mjs', 'utf8'), /assertOwnedSource/)
  const pkg = JSON.parse(readFileSync('ui/package.json', 'utf8'))
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0)
  const lock = JSON.parse(readFileSync('ui/package-lock.json', 'utf8'))
  for (const [path, item] of Object.entries(lock.packages)) if (path) assert.equal(item.dev, true, `${path} must not become a runtime dependency`)
})
const source = { source: 'url', type: 'zip', url: 'https://example.com/p.zip', sha256: 'a'.repeat(64) }
const catalog = { name: 'demo', scope: 'personal', description: 'Demo', descriptionI18n: { en: 'Demo' }, version: '1.0', category: 'tests', icon: null, source }
const skill = { name: 'demo', description: 'Demo', relativePath: 'skills/demo/SKILL.md', sha256: 'b'.repeat(64) }
const installed = { name: 'demo', version: '1.0', description: 'Demo', digest: source.sha256, enabled: false, mcpEnabled: false, mcpConfigSha256: null, capabilities: ['skills'], skills: [skill] }
const values = {
  'plugins/catalog': { plugins: [catalog] },
  'plugins/installed': { plugins: [installed] },
  'plugins/updates': { updates: [{ name: 'demo', installedVersion: '1.0', availableVersion: '2.0', availableDigest: 'c'.repeat(64) }] },
  'plugins/importCatalog': { plugins: [catalog] },
  'plugins/uninstall': { ok: true },
  'plugins/mcpPreview': { servers: [{ server: 'demo', command: 'node', args: ['server.js'], envKeys: ['TOKEN'], envSources: {TOKEN:'Host environment: API_TOKEN'} }] },
  ...Object.fromEntries(['install', 'enable', 'disable', 'mcpEnable', 'mcpDisable'].map(op => [`plugins/${op}`, { plugin: installed }])),
}
const envelope = value => ({ ok: true, value })
for (const [endpoint, value] of Object.entries(values)) {
  test(`decodes ${endpoint}`, () => assert.deepEqual(copy(api.decodeResponse(endpoint, envelope(value))), value))
}
test('only documented optional fields receive legacy defaults', () => {
  const minimal = { name: 'demo', source: { ...source } }
  const decoded = copy(api.decodeResponse('plugins/catalog', envelope({ plugins: [minimal] })))
  assert.deepEqual(decoded, { plugins: [{ ...catalog, scope: 'public', description: '', descriptionI18n: {}, version: '', category: '', source, icon: null }] })
  const legacy = { ...installed }; delete legacy.mcpEnabled; delete legacy.mcpConfigSha256
  assert.deepEqual(copy(api.decodeResponse('plugins/installed', envelope({ plugins: [legacy] }))), { plugins: [installed] })
})
test('unknown extra fields are tolerated but never added to decoded DTOs', () => {
  const decoded = api.decodeResponse('plugins/catalog', { ok: true, future: 'allowed', value: { ...values['plugins/catalog'], future: 7 } })
  assert.equal(decoded.future, undefined)
  assert.deepEqual(copy(decoded), values['plugins/catalog'])
})
test('JSON __proto__ locale does not mutate prototypes', () => {
  const entry = { ...catalog, descriptionI18n: JSON.parse('{"__proto__":"text","en":"Demo"}') }
  const result = api.decodeResponse('plugins/catalog', envelope({ plugins: [entry] }))
  assert.equal(Object.prototype.hasOwnProperty.call(result.plugins[0].descriptionI18n, '__proto__'), true)
  assert.equal(result.plugins[0].descriptionI18n.__proto__, 'text')
  assert.equal({}.polluted, undefined)
})
for (const [index, input] of [null, [], 'secret-raw-response', {}, { ok: 'true', value: {} }, { ok: true }, { ok: true, value: null }, { ok: true, value: {}, error: {} }, { ok: false }, { ok: false, error: { code: 42, message: 'x' } }, { ok: false, error: { code: 'failed', message: 'x' }, value: {} }].entries()) {
  test(`rejects malformed envelope ${index} without raw response in message`, () => {
    assert.throws(() => api.decodeResponse('plugins/catalog', input), error => error instanceof api.PluginProtocolError && !error.message.includes('secret-raw-response'))
  })
}
const invalidValues = [
  ['plugins/catalog', {}], ['plugins/catalog', { plugins: null }],
  ['plugins/catalog', { plugins: [{}] }],
  ['plugins/catalog', { plugins: [{ ...catalog, descriptionI18n: { en: 7 } }] }],
  ['plugins/catalog', { plugins: [{ ...catalog, source: { ...source, sha256: 7 } }] }],
  ['plugins/catalog', { plugins: [{ ...catalog, icon: 7 }] }],
  ['plugins/installed', { plugins: [{ ...installed, enabled: 'false' }] }],
  ['plugins/installed', { plugins: [{ ...installed, capabilities: 'skills' }] }],
  ['plugins/installed', { plugins: [{ ...installed, skills: [{ name: 'demo', description: 'x' }] }] }],
  ['plugins/updates', { updates: [{ name: 'demo', version: '2.0' }] }],
  ['plugins/mcpPreview', { servers: [{ server: 'x', command: 'node', args: [], envKeys: [null] }] }],
  ['plugins/uninstall', { ok: false }], ['plugins/install', { plugin: null }],
]
for (const [index, [endpoint, value]] of invalidValues.entries()) {
  test(`rejects missing or wrong DTO field ${index}`, () => assert.throws(() => api.decodeResponse(endpoint, envelope(value)), api.PluginProtocolError))
}
test('remote errors retain code and details; compatibility only suppresses exact unsupported endpoint', () => {
  const endpoint = 'plugins/mcpPreview'
  const fail = message => ({ ok: false, error: { code: 'bad-request', message, details: { reason: 'test' } } })
  let error
  try { api.decodeResponse(endpoint, fail(`unsupported plugin endpoint ${endpoint}`)) } catch (caught) { error = caught }
  assert.equal(api.isUnsupportedEndpoint(error, endpoint), true)
  assert.equal(api.isUnsupportedEndpoint(error, 'plugins/catalog'), false)
  assert.equal(error.code, 'bad-request')
  assert.deepEqual(copy(error.details), { reason: 'test' })
  assert.throws(() => api.decodeResponse(endpoint, fail('invalid configuration')), caught => !api.isUnsupportedEndpoint(caught, endpoint))
})
test('request validates before transport; missing/invalid mutation never sends', async () => {
  let sends = 0
  const call = api.createPluginClient({ call: async () => { sends++; return envelope({}) } })
  for (const [endpoint, args] of [
    ['plugins/install', undefined], ['plugins/enable', { name: '' }], ['plugins/uninstall', { name: 3 }],
    ['plugins/setSourcePreference', { preference: 'gitee' }], ['plugins/importCatalog', { content: '{}', scope: 'all' }],
    ['plugins/refreshCatalog', {}], ['plugins/typo', {}],
  ]) await assert.rejects(call(endpoint, args), api.PluginProtocolError)
  assert.equal(sends, 0)
})
test('transport uses existing API envelope and does not retry mutations', async () => {
  const requests = []
  const cause = Error('connection closed after send')
  const call = api.createPluginClient({ async call(...request) { requests.push(request); throw cause } })
  await assert.rejects(call('plugins/install', { name: 'demo' }), error => error instanceof api.PluginTransportError && error.cause === cause)
  assert.equal(requests.length, 1)
  assert.deepEqual(copy(requests[0]), ['/api', 'plugins/install', { args: { name: 'demo' } }])
})
test('concurrent calls and different clients do not share response state', async () => {
  const a = api.createPluginClient({ call: async (_channel, endpoint) => envelope(values[endpoint]) })
  const b = api.createPluginClient({ call: async () => envelope({ plugins: [] }) })
  const [catalogA, installedA, catalogB] = await Promise.all([a('plugins/catalog'), a('plugins/installed'), b('plugins/catalog')])
  assert.equal(catalogA.plugins[0].name, 'demo')
  assert.equal(installedA.plugins[0].enabled, false)
  assert.deepEqual(copy(catalogB), { plugins: [] })
})

test('unknown endpoints and inherited prototype keys fail through the protocol error path', () => {
  for (const endpoint of ['plugins/typo', '__proto__', 'constructor', 'toString']) {
    assert.throws(() => api.decodeResponse(endpoint, envelope({})),
      error => error instanceof api.PluginProtocolError && error.message.includes('unsupported endpoint'))
  }
})
test('endpoint payloads cannot be substituted for another endpoint', () => {
  for (const [endpoint, value] of [
    ['plugins/installed', values['plugins/catalog']],
    ['plugins/catalog', values['plugins/installed']],
    ['plugins/install', values['plugins/uninstall']],
    ['plugins/uninstall', values['plugins/install']],
    ['plugins/mcpPreview', values['plugins/updates']],
  ]) assert.throws(() => api.decodeResponse(endpoint, envelope(value)), api.PluginProtocolError)
})

test('MCP environment sources preserve main consent metadata and reject malformed bindings', () => {
  const value = values['plugins/mcpPreview'];
  assert.equal(api.decodeResponse('plugins/mcpPreview', envelope(value)).servers[0].envSources.TOKEN, 'Host environment: API_TOKEN');
  const legacy = copy(value);delete legacy.servers[0].envSources;
  assert.deepEqual(copy(api.decodeResponse('plugins/mcpPreview', envelope(legacy))).servers[0].envSources, {});
  for (const bad of [null, [], {TOKEN:42}]) {const input=copy(value);input.servers[0].envSources=bad;assert.throws(()=>api.decodeResponse('plugins/mcpPreview', envelope(input)), /envSources/)}
});
