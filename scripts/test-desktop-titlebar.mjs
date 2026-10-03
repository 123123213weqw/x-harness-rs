import {scriptAsset} from './fixtures/script-asset-test.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const source = scriptAsset('desktop-titlebar.js')
const css = readFileSync(new URL('ui/desktop/titlebar.css', root), 'utf8')
const config = JSON.parse(readFileSync(new URL('apps/desktop/src-tauri/tauri.conf.json', root), 'utf8'))
const capability = JSON.parse(readFileSync(new URL('apps/desktop/src-tauri/capabilities/desktop-main.json', root), 'utf8'))
const bootstrap = readFileSync(new URL('apps/desktop/frontend/index.html', root), 'utf8')
const assembled = readFileSync(new URL('ui/dist/index.html', root), 'utf8')

assert.equal(config.app.windows[0].titleBarStyle, 'Overlay')
assert.equal(config.app.windows[0].hiddenTitle, true)
assert.equal(config.app.windows[0].theme, undefined, 'startup follows the OS until the resolved UI scheme arrives')
assert.ok(capability.permissions.includes('core:window:allow-start-dragging'))
assert.ok(capability.permissions.includes('core:window:allow-set-theme'))
assert.match(bootstrap, /data-tauri-drag-region/)
assert.match(css, /#root\s*\{[^}]*height:\s*calc\(100% - 32px\)/)
assert.match(css, /inset:\s*0 0 0 184px/)
assert.match(css, /#xh-desktop-titlebar-controls\s*\{[^}]*left:\s*88px/)
assert.match(assembled, /desktop-titlebar\.css\?rev=[a-f0-9]+/)
assert.match(assembled, /desktop-titlebar\.js\?rev=[a-f0-9]+/)

function fixture({ mac, desktop, loading = false, scheme = '', setTheme }) {
  const nodes = new Map()
  const listeners = new Map()
  const added = []
  const events = []
  const observers = [], windowListeners = new Map(), warnings = []
  const document = {
    readyState: loading ? 'loading' : 'complete',
    documentElement: { dataset: {}, style: { colorScheme: scheme } },
    body: { prepend: node => { added.unshift(node); nodes.set(node.id, node) } },
    getElementById: id => nodes.get(id) ?? null,
    createElement: tag => ({
      tag,
      children: [],
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value },
      appendChild(child) { this.children.push(child) },
    }),
    addEventListener: (name, callback) => listeners.set(name, callback),
  }
  const context = {
    window: { ...(desktop ? { __TAURI__: { core: { invoke() {} }, ...(setTheme ? { window: { getCurrentWindow: () => ({ setTheme }) } } : {}) } } : {}), dispatchEvent: event => { events.push(event.type) },
      addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name) },
    MutationObserver: class {
      constructor(callback) { this.callback=callback; this.active=true; observers.push(this) }
      observe(target, options) { this.target=target; this.options=options }
      disconnect() { this.active=false }
    },
    console: {warn: message => warnings.push(message)},
    Event,
    navigator: { userAgent: mac ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' : 'Mozilla/5.0 (X11; Linux x86_64)' },
    document,
  }
  const run = () => vm.runInNewContext(source, context)
  return { document, added, listeners, events, run, observers, warnings,
    changeScheme(value) { document.documentElement.style.colorScheme=value; for(const observer of observers) if(observer.active) observer.callback() },
    changeTheme(preference, scheme) { document.documentElement.dataset.xhThemePreference=preference;document.documentElement.style.colorScheme=scheme;for(const observer of observers) if(observer.active) observer.callback() },
    pagehide() { windowListeners.get('pagehide')?.() } }
}

for (const options of [{ mac: true, desktop: false }, { mac: false, desktop: true }]) {
  const page = fixture(options)
  page.run()
  assert.deepEqual(page.added, [])
  assert.equal(page.document.documentElement.dataset.xhMacTitlebar, undefined)
}

const app = fixture({ mac: true, desktop: true, loading: true })
app.run()
assert.equal(app.document.documentElement.dataset.xhMacTitlebar, 'overlay')
assert.equal(app.added.length, 0)
app.listeners.get('DOMContentLoaded')()
app.run()
assert.equal(app.added.length, 1, 'repeat initialization must not duplicate the drag strip')
assert.equal(app.added[0].children[0].attributes['data-tauri-drag-region'], '')
assert.equal(app.added[0].attributes['aria-hidden'], undefined, 'interactive titlebar is exposed to accessibility')
assert.equal(app.added[0].children[0].attributes['aria-hidden'], 'true', 'only the empty drag region is decorative')
assert.equal(app.added[0].children[1].id, 'xh-desktop-titlebar-controls')
assert.equal(app.added[0].children[1].attributes['data-tauri-drag-region'], undefined, 'controls never start native dragging')
assert.deepEqual(app.events, ['xh-desktop-titlebar-ready'], 'deferred native mount notifies React exactly once')
console.log('macOS titlebar reserves accessible controls outside dragging; browser/other platforms and duplicate init are unchanged.')


// This exercises the real bundled bridge, not a second theme preference owner.
const flush = () => new Promise(resolve => setImmediate(resolve))
const nativeCalls=[]
const nativePage=fixture({mac:false,desktop:true,setTheme:async scheme=>nativeCalls.push(scheme)})
nativePage.run(); await flush()
assert.deepEqual(nativeCalls, [], 'startup does not guess a scheme before ThemePresenter resolves it')
nativePage.changeScheme('light'); await flush()
nativePage.changeScheme('light'); await flush()
nativePage.run(); await flush()
assert.deepEqual(nativeCalls, ['light'], 'same scheme and repeated initialization do not issue more native writes')
assert.equal(nativePage.observers.length,1)
assert.deepEqual(Array.from(nativePage.observers[0].options.attributeFilter), ['style','data-xh-theme-preference'])
nativePage.changeScheme('dark'); await flush()
assert.deepEqual(nativeCalls, ['light','dark'], 'explicit appearance reaches non-macOS native chrome too')
nativePage.changeScheme('light dark'); await flush()
assert.deepEqual(nativeCalls, ['light','dark'], 'unresolved multi-scheme values are not guessed')
nativePage.changeTheme('system','dark');await flush()
nativePage.changeTheme('system','light');await flush()
assert.deepEqual(nativeCalls,['light','dark',null], 'System releases the native override once; OS changes do not re-pin it')
nativePage.changeTheme('light','light');await flush()
assert.deepEqual(nativeCalls,['light','dark',null,'light'])
nativePage.pagehide(); nativePage.changeScheme('dark'); await flush()
assert.deepEqual(nativeCalls, ['light','dark',null,'light'], 'disposed documents stop synchronizing')
assert.equal(nativePage.observers[0].active,false)
assert.equal(nativePage.document.documentElement.dataset.xhNativeThemeSync,undefined)

let release
const pending = new Promise(resolve => { release=resolve }), serialized=[]
const slow=fixture({mac:false,desktop:true,scheme:'dark',setTheme:scheme=>{
 serialized.push(scheme); return serialized.length===1 ? pending : Promise.resolve()
}})
slow.run(); slow.changeScheme('light'); slow.changeScheme('dark'); slow.changeScheme('light')
assert.deepEqual(serialized,['dark'], 'at most one native write is in flight')
release(); await flush()
assert.deepEqual(serialized,['dark','light'], 'latest resolved appearance wins after the slow old request')
slow.pagehide()

const rejected=[]
const unavailable=fixture({mac:false,desktop:true,scheme:'light',setTheme:async scheme=>{
 rejected.push(scheme); throw Error('native permission unavailable')
}})
unavailable.run(); await flush(); unavailable.changeScheme('light'); await flush()
assert.deepEqual(rejected,['light'], 'an unavailable native bridge cannot enter a retry loop')
assert.equal(unavailable.warnings.length,1)
unavailable.pagehide()
console.log('Native theme follows resolved UI appearance: idempotence, serialized rapid switches, non-macOS, failures and disposal passed.')
