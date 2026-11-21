import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {assertRebuildInput} from './fixtures/repository-ui-input.mjs'

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
const shippedLayout = read(`ui/dist/plugins/${layout}/client.js`)
assert.match(read('ui/dist/index.html'), /@xlang\/xharness-client-ui-browser/)
assert.match(read(`ui/dist/plugins/${layout}/client.js`), /sessionId: spaceKey === ["\']__global__["\'] \? null : spaceKey/, 'the live session, not a persisted tab, owns browser binding')
assert.match(read('ui/src/modules/layout/workspace-pane.tsx'), /item:active,sessionId,open,onUpdate/,
  'native child presentation follows dock visibility instead of always being open')
const css=read('ui/src/modules/layout/AppFrame.css');assert.ok(shippedLayout.includes(JSON.stringify(css)), 'the exact workspace/drawer/scrim CSS is actually embedded in the source-built factory')
// Assert the actual shipped CSS layering, not only an obsolete patch transform.
const declarations=(selector,property)=>{
 const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(row=>row[1].trim()===selector)
 assert.ok(rules.length,'layout rule '+selector)
 // Responsive grid/padding rules may repeat a selector without overriding its
 // stacking contract. Inspect declarations rather than assuming one rule.
 return rules.flatMap(row=>[...row[2].matchAll(new RegExp('(?:^|;)'+property+':([^;]+)','g'))].map(value=>value[1]))
}
for(const selector of ['._84hhiq_centerCol','._84hhiq_detailsCol']){
 assert.deepEqual(declarations(selector,'isolation'),['isolate'],'child content keeps its stacking seat')
 assert.deepEqual(declarations(selector,'z-index'),['0'],'responsive rules do not lift child content above global controls')
}
const z=selector=>{const values=declarations(selector,'z-index');assert.equal(values.length,1,'one explicit stacking level '+selector);return Number(values[0])}
const scrimZ=z('._84hhiq_workspaceScrim'),drawerZ=z('._84hhiq_frame[data-xhworkspace-drawer] ._84hhiq_detailsCol'),overlayZ=z('._84hhiq_overlayLayer')
assert.ok(scrimZ<drawerZ&&drawerZ<overlayZ,'workspace scrim and drawer remain below global overlay controls')
assert.match(read('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js'), /"data-composer-seat"/,
  'chat shortcuts require the stable composer wrapper to survive upstream UI rebuilds')
const capability = JSON.parse(read('apps/desktop/src-tauri/capabilities/desktop-main.json'))
assert.deepEqual(capability.webviews, ['main'])
assert.equal(capability.windows, undefined, 'window-scoped capabilities would leak into child WebViews')
assert.ok(capability.remote.urls.every(url => url.startsWith('http://127.0.0.1:')))
const nativeSource=read('apps/desktop/src-tauri/src/browser.rs')
const browserContracts=read('crates/xharness-browser/src/contracts.rs')
assert.match(nativeSource, /data_directory\(browser_data\)/)
assert.match(nativeSource, /use xharness_browser::web_url;/, 'desktop and standalone Host share the URL policy')
assert.match(browserContracts, /only http and https pages are supported/)
const navigationPolicy=nativeSource.split('.on_navigation(move |url| {')[1].split('.on_document_title_changed')[0]
assert.match(nativeSource, /let target = web_url\(&url\)\?;/, 'explicit open uses the shared URL policy')
assert.match(navigationPolicy, /matches!\(url\.scheme\(\), "http" \| "https"\)/, 'native navigation continues to reject other schemes')
assert.doesNotMatch(navigationPolicy,/\.store\(|delegation\.navigate|"url"/,'frame-agnostic policy must not publish addresses or mutate top-level readiness/binding')
assert.match(navigationPolicy,/navigation_inspector\.invalidate\(\)/,'unclassified navigations must still invalidate action refs')
const pageLoad=nativeSource.split('.on_page_load(move |_, payload| {')[1].split('.on_new_window')[0]
assert.match(pageLoad,/"url", payload\.url\(\)\.as_str\(\)/,'only native top-level callbacks publish the address')
assert(pageLoad.indexOf('"url", payload.url()')<pageLoad.indexOf('status, payload.url()'),'committed URL is published before readiness')
console.log('browser bundle, graph, and child WebView isolation passed')
