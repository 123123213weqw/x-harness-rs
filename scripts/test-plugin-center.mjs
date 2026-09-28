import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { patchPluginCenter } from './patch-plugin-center.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(root, 'ui/dist')
const read = path => readFileSync(resolve(dist, path), 'utf8')
const graph = JSON.parse(read('client-graph.json'))
const html = read('index.html')
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
assert.equal(graph.rev, hash(JSON.stringify(graph.entries)))
const boot = html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)
assert.ok(boot)
assert.deepEqual(JSON.parse(boot[1]), graph, 'HTML and shipped graph must agree')

const ids = ['layout', 'workspace', 'settings-plugins'].map(name => `@xharness/dsh-client-ui-${name}`)
for (const id of ids) {
  const bytes = readFileSync(resolve(dist, 'plugins', id, 'client.js'))
  const entry = graph.entries.find(item => item.id === id)
  assert.ok(entry, `${id} must ship`)
  assert.equal(entry.rev, hash(bytes))
  assert.equal(entry.url, `/plugins/${id}/client.js?rev=${entry.rev}`)
  assert.equal(patchPluginCenter(id, bytes).toString(), bytes.toString(), `${id} patch must be repeatable`)
  new vm.Script(bytes.toString())
}

const layout = read('plugins/@xharness/dsh-client-ui-layout/client.js')
const workspace = read('plugins/@xharness/dsh-client-ui-workspace/client.js')
const settings = read('plugins/@xharness/dsh-client-ui-settings-plugins/client.js')
assert.match(layout, /renderSlot\("plugins\.center", \{\}\)/)
assert.match(layout, /"plugins\.center": \{\s*kind: "single",\s*scope: "root"/)
assert.match(layout, /onClickCapture: \(event\) =>/)
assert.equal((workspace.match(/"data-xharness-plugin-nav": true/g) ?? []).length, 2, 'wide and compact buttons')
assert.match(workspace, /function PluginOutline16\(/, 'navigation has a dedicated plugin icon')
assert.equal((workspace.match(/react_jsx_runtime\.jsx\)\(PluginOutline16,/g) ?? []).length, 2, 'both layouts use the same icon')
assert.match(workspace, /M2\.4 2\.5h3\.05c-\.15\.64/, 'shipped icon matches the approved vector')
assert.match(workspace, /transform: "translate\(0 -0\.75\) scale\(1\.2\)"/, 'sidebar glyph fills and centers its viewport')
assert.match(workspace, /"plugins\.open": "插件"/)
assert.match(workspace, /"plugins\.open": "Plugins"/)
assert.match(workspace, /"aria-current": pluginCenterOpen \? "page" : void 0/)
assert.match(settings, /ctx\.slots\.inject\("plugins\.advanced",/)
assert.doesNotMatch(settings, /ctx\.slots\.inject\("settings\.section",/, 'Plugins must no longer appear in Settings nav')
assert.match(settings, /ctx\.slots\.inject\("settings\.plugins\.tab",/, 'existing tab content remains')
assert.match(settings, /ctx\.slots\.inject\("settings\.plugin\.item",/, 'existing configuration cards remain')
assert.match(readFileSync(resolve(root, 'scripts/assemble-static-ui.mjs'), 'utf8'), /bytes = patchPluginCenter\(entry\.name, bytes\)/)
const hubId = '@xlang/xharness-client-ui-plugin-hub'
const hubEntry = graph.entries.find(item => item.id === hubId)
assert.ok(hubEntry, 'product-owned hub is present in the shipped graph')
assert.equal(hubEntry.rev, hash(readFileSync(resolve(dist, 'plugins', hubId, 'client.js'))))
const hub = read(`plugins/${hubId}/client.js`)
assert.match(hub, /ctx\.slots\.inject\('plugins\.center'/)
assert.doesNotMatch(hub, /plugins\.advanced|emptyBody|emptyStep|xhph-steps|xhph-advanced/)
assert.match(hub, /No user plugins installed/)
assert.doesNotMatch(hub, /Extend what XHarness can do|扩展 XHarness 的能力|Install from file|从文件安装|xhph-subtitle|xhph-install\b/)
assert.match(hub, /width: 30, height: 30/, 'empty-state icon fits the compact installed row')
assert.match(hub, /transform: 'translate\(0 -0\.75\) scale\(1\.2\)'/, 'empty-state glyph uses the centered sidebar geometry')
assert.match(hub, /const options = \['public', 'personal'\]/, 'marketplace uses Public and Personal sections')
assert.doesNotMatch(hub, /detailsTitle|detailsEmpty|updatesTitle|updatesBody/, 'old split pane and empty Updates tab are removed')
assert.match(hub, /plugins\/catalog/, 'plugin hub loads its catalog from Host')
assert.match(hub, /plugins\/installed/, 'plugin hub loads installed state from Host')
assert.doesNotMatch(hub, /pluginInventory\/list|dynamicCordisRunner/, 'no unsupported upstream RPC calls')
new vm.Script(hub)

console.log('plugin center: first-level wide/compact navigation, shared settings content, removed Settings entry, rebuild and boot graph passed')
