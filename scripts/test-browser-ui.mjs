import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { patchBrowserDock } from './patch-browser-dock.mjs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const graph = JSON.parse(read('ui/dist/client-graph.json'))
const browser = '@xlang/xharness-client-ui-browser'
const layout = '@xharness/dsh-client-ui-layout'
const entry = graph.entries.find(value => value.id === browser)
assert.ok(entry, 'shipped plugin graph must include the desktop browser')
assert.ok(graph.entries.findIndex(value => value.id === layout) < graph.entries.indexOf(entry))
assert.equal(read(`ui/dist/plugins/${browser}/client.js`), read(`ui/plugins/${browser}/client.js`))
assert.equal(patchBrowserDock(Buffer.from(read(`ui/dist/plugins/${layout}/client.js`))).toString(), read(`ui/dist/plugins/${layout}/client.js`))
assert.match(read('ui/dist/index.html'), /@xlang\/xharness-client-ui-browser/)
assert.match(read(`ui/dist/plugins/${layout}/client.js`), /sessionId: spaceKey === "__global__" \? null : spaceKey/, 'the live session, not a persisted tab, owns browser consent')
assert.match(read('ui/overrides/workspace-pane.js'), /item: active, sessionId, open: true/)
assert.match(read('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js'), /"data-composer-seat"/,
  'chat shortcuts require the stable composer wrapper to survive upstream UI rebuilds')
const capability = JSON.parse(read('apps/desktop/src-tauri/capabilities/desktop-main.json'))
assert.deepEqual(capability.webviews, ['main'])
assert.equal(capability.windows, undefined, 'window-scoped capabilities would leak into child WebViews')
assert.ok(capability.remote.urls.every(url => url.startsWith('http://127.0.0.1:')))
assert.match(read('apps/desktop/src-tauri/src/browser.rs'), /data_directory\(browser_data\)/)
assert.match(read('apps/desktop/src-tauri/src/browser.rs'), /only http and https pages are supported/)
console.log('browser bundle, graph, and child WebView isolation passed')
