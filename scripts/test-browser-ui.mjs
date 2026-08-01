import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {assertRebuildInput} from './fixtures/repository-ui-input.mjs'
import { patchBrowserDock } from './patch-browser-dock.mjs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const graph = JSON.parse(read('ui/dist/client-graph.json'))
const browser = '@xlang/xharness-client-ui-browser'
const layout = '@xharness/dsh-client-ui-layout'
const entry = graph.entries.find(value => value.id === browser)
assert.ok(entry, 'shipped plugin graph must include the desktop browser')
assert.ok(graph.entries.findIndex(value => value.id === layout) < graph.entries.indexOf(entry))
assertRebuildInput(browser);assertRebuildInput(layout)
assert.doesNotMatch(read(`ui/dist/plugins/${browser}/client.js`), /BrowserAccess|useBrowserAccess|xhbrowser-access-/,
  'manual browser access controls must not return in fresh builds')
assert.doesNotMatch(read(`ui/dist/plugins/${browser}/client.js`), /xhbrowser-footer|xhbrowser-status-dot|独立网页引擎/,'the engine status strip and its reserved height must not return')
const frozen=read(`ui/reference/master-a613970/plugins/${layout}/client.js`);assert.equal(patchBrowserDock(Buffer.from(frozen)).toString(),frozen,'historical frozen dock patch remains idempotent')
const shippedLayout = read(`ui/dist/plugins/${layout}/client.js`)
const previousLayers = frozen.replaceAll('isolation:isolate;z-index:0;', '')
  .replace('z-index:10;box-shadow:-14px 0 40px #0004', 'z-index:25;box-shadow:-14px 0 40px #0004')
  .replace('._84hhiq_workspaceScrim{position:absolute;inset:0;z-index:9;', '._84hhiq_workspaceScrim{position:absolute;inset:0;z-index:24;')
assert.equal(patchBrowserDock(Buffer.from(previousLayers)).toString(), frozen,
  'refresh an already-patched release, not just fresh upstream builds')
assert.match(read('ui/dist/index.html'), /@xlang\/xharness-client-ui-browser/)
assert.match(read(`ui/dist/plugins/${layout}/client.js`), /sessionId: spaceKey === ["\']__global__["\'] \? null : spaceKey/, 'the live session, not a persisted tab, owns browser binding')
assert.match(read('ui/src/modules/layout/workspace-pane.tsx'), /item:active,sessionId,open:true/)
const css=read('ui/src/modules/layout/AppFrame.css');assert.ok(shippedLayout.includes(JSON.stringify(css)), 'the exact workspace/drawer/scrim CSS is actually embedded in the source-built factory')
assert.match(read('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js'), /"data-composer-seat"/,
  'chat shortcuts require the stable composer wrapper to survive upstream UI rebuilds')
const capability = JSON.parse(read('apps/desktop/src-tauri/capabilities/desktop-main.json'))
assert.deepEqual(capability.webviews, ['main'])
assert.equal(capability.windows, undefined, 'window-scoped capabilities would leak into child WebViews')
assert.ok(capability.remote.urls.every(url => url.startsWith('http://127.0.0.1:')))
assert.match(read('apps/desktop/src-tauri/src/browser.rs'), /data_directory\(browser_data\)/)
assert.match(read('apps/desktop/src-tauri/src/browser.rs'), /only http and https pages are supported/)
console.log('browser bundle, graph, and child WebView isolation passed')
