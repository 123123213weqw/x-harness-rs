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
assert.ok(capability.permissions.includes('core:window:allow-start-dragging'))
assert.match(bootstrap, /data-tauri-drag-region/)
assert.match(css, /#root\s*\{[^}]*height:\s*calc\(100% - 32px\)/)
assert.match(css, /inset:\s*0 0 0 128px/)
assert.match(css, /#xh-desktop-titlebar-controls\s*\{[^}]*left:\s*88px/)
assert.match(assembled, /desktop-titlebar\.css\?rev=[a-f0-9]+/)
assert.match(assembled, /desktop-titlebar\.js\?rev=[a-f0-9]+/)

function fixture({ mac, desktop, loading = false }) {
  const nodes = new Map()
  const listeners = new Map()
  const added = []
  const events = []
  const document = {
    readyState: loading ? 'loading' : 'complete',
    documentElement: { dataset: {} },
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
    window: { ...(desktop ? { __TAURI__: { core: { invoke() {} } } } : {}), dispatchEvent: event => { events.push(event.type) } },
    Event,
    navigator: { userAgent: mac ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' : 'Mozilla/5.0 (X11; Linux x86_64)' },
    document,
  }
  const run = () => vm.runInNewContext(source, context)
  return { document, added, listeners, events, run }
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
