import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import {scriptAsset,scriptAssetDist} from './fixtures/script-asset-test.mjs'

const source = scriptAsset('desktop-updater.js')
const window = {}
vm.runInNewContext(source, { window }) // Browser/SSR: no Tauri or DOM must be harmless.
const { updateView, createController } = window.__XHARNESS_DESKTOP_UPDATER_TEST__
let assertions = 0
function test(name, fn) { return Promise.resolve().then(fn).then(() => { assertions++; console.log('ok - ' + name) }) }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const snapshot = (seq, phase, fields = {}) => ({ seq, phase, ...fields })

await test('all phases and bounded/unknown progress', () => {
  assert.equal(updateView({}).action, '检查更新')
  assert.equal(updateView({ phase: 'available', version: '1.2.3' }).action, '下载更新')
  assert.match(updateView({ phase: 'available', version: '1.2.3' }).label, /1\.2\.3/)
  assert.equal(updateView({ phase: 'downloaded' }).action, '重启更新')
  for (const phase of ['checking', 'downloading', 'stopping-host', 'host-force-stopped', 'installing', 'recovering-host', 'installed']) assert.equal(updateView({ phase }).busy, true)
  for (const phase of ['idle', 'available', 'downloaded', 'up-to-date', 'error']) assert.equal(updateView({ phase }).busy, false)
  assert.match(updateView({ phase: 'downloading', downloaded: 51, total: 100 }).label, /51%/)
  assert.match(updateView({ phase: 'downloading', downloaded: 200, total: 100 }).label, /100%/)
  assert.doesNotMatch(updateView({ phase: 'downloading', downloaded: 5, total: null }).label, /NaN|Infinity|%/)
  assert.equal(updateView({ phase: 'error' }).action, '重试')
})

await test('download never calls install; dismiss/escape equivalent never installs', async () => {
  const calls = []
  const c = createController(async (command, args) => { calls.push([command, args]); return snapshot(2, 'downloaded') })
  c.accept(snapshot(1, 'available'))
  await c.act()
  assert.deepEqual(calls.map(c => c[0]), ['desktop_download_update'])
  c.act()
  assert.equal(c.confirming, true)
  c.dismiss()
  await c.confirm()
  assert.equal(calls.length, 1)
  c.act()
  await c.confirm()
  assert.equal(calls[1][0], 'desktop_install_update')
  assert.equal(calls[1][1].confirmStop, true)
})

await test('rapid repeated clicks start only one operation', async () => {
  const d = deferred(), calls = []
  const c = createController(command => { calls.push(command); return d.promise })
  c.accept(snapshot(1, 'available'))
  const first = c.act()
  await c.act()
  await c.check()
  assert.equal(calls.length, 1)
  d.resolve(snapshot(2, 'downloaded'))
  await first
  assert.equal(c.state.phase, 'downloaded')
})

await test('reload restores ready download and timer does not replace it', async () => {
  const calls = []
  const c = createController(async command => { calls.push(command); return snapshot(19, 'downloaded', { version: '1.2.0' }) })
  await c.restore()
  await c.check()
  c.accept(snapshot(4, 'downloading'))
  assert.equal(c.state.phase, 'downloaded')
  assert.equal(c.state.version, '1.2.0')
  assert.deepEqual(calls, ['desktop_update_status'])
})

await test('reload during download blocks another download and rejects stale status', async () => {
  const d = deferred()
  const c = createController(() => d.promise)
  const restore = c.restore()
  c.accept(snapshot(8, 'downloading'))
  d.resolve(snapshot(7, 'available'))
  await restore
  assert.equal(c.state.phase, 'downloading')
  await c.act()
  assert.equal(c.state.seq, 8)
})

for (const action of ['check', 'download', 'install']) {
  await test(action + ' failure retries the correct command; install must confirm again', async () => {
    const calls = []
    const c = createController(async command => {
      calls.push(command)
      if (command === 'desktop_update_status') return snapshot(2, 'error', { retryAction: action, message: 'offline or installer error' })
      throw new Error('failed')
    })
    c.accept(snapshot(1, action === 'install' ? 'downloaded' : action === 'download' ? 'available' : 'idle'))
    await c.act()
    if (action === 'install') await c.confirm()
    assert.equal(c.state.phase, 'error')
    assert.equal(c.state.retryAction, action)
    const before = calls.length
    await c.act()
    if (action === 'install') {
      assert.equal(c.confirming, true)
      assert.equal(calls.length, before)
      await c.confirm()
    }
    assert.equal(calls[before], 'desktop_' + (action === 'check' ? 'check' : action === 'download' ? 'download' : 'install') + '_update')
  })
}

await test('IPC disconnect becomes retryable; malformed events ignored', async () => {
  const c = createController(async () => { throw new Error('bridge disconnected') })
  c.accept(snapshot(1, 'available'))
  await c.act()
  assert.equal(c.state.phase, 'error')
  assert.equal(c.state.retryAction, 'download')
  for (const malformed of [null, {}, { seq: NaN }, { seq: '5' }, { seq: -50, phase: 'installed' }]) c.accept(malformed)
  assert.equal(c.state.phase, 'error')
})

await test('install retry cannot be replaced by automatic check', async () => {
  let calls = 0
  const c = createController(async () => { calls++; })
  c.accept(snapshot(1, 'error', { retryAction: 'install' }))
  await c.check()
  assert.equal(calls, 0)
  await c.act()
  c.accept(snapshot(2, 'installing'))
  assert.equal(c.confirming, false)
  await c.act()
  assert.equal(calls, 0)
})

await test('background preparation checks then downloads, never installs or asks to stop', async () => {
  const calls = []
  const c = createController(async command => {
    calls.push(command)
    return command === 'desktop_check_update' ? snapshot(1, 'available') : snapshot(2, 'downloaded')
  })
  await c.prepare()
  await c.prepare()
  assert.deepEqual(calls, ['desktop_check_update', 'desktop_download_update'])
  assert.equal(c.confirming, false)
  assert.equal(c.state.phase, 'downloaded')
})

await test('available restored candidates only download; downloaded restored candidates do nothing', async () => {
  for (const phase of ['available', 'downloaded']) {
    const calls = []
    const c = createController(async command => {calls.push(command); return snapshot(2, 'downloaded')})
    c.accept(snapshot(1, phase))
    await c.prepare()
    assert.deepEqual(calls, phase === 'available' ? ['desktop_download_update'] : [])
  }
})

await test('automatic retry has three backoffs then stops; manual retry re-arms preparation', async () => {
  let seq = 0, calls = 0
  const c = createController(async command => {
    if (command === 'desktop_update_status') return snapshot(++seq, 'error', {retryAction: 'check'})
    calls++; throw Error('offline')
  })
  for (const delay of [30_000, 120_000, 600_000, undefined]) {
    await c.prepare(); assert.equal(c.retryDelay, delay)
  }
  await c.prepare(); assert.equal(calls, 4)
  await c.act(); assert.equal(calls, 5)
  await c.prepare(); assert.equal(calls, 6)
})

await test('concurrent preparation, dispose during check, and install errors cannot auto-install', async () => {
  const d = deferred(), calls = []
  const c = createController(command => {calls.push(command); return d.promise})
  const first = c.prepare()
  await c.prepare(); await c.act()
  assert.deepEqual(calls, ['desktop_check_update'])
  c.dispose(); d.resolve(snapshot(2, 'available')); await first
  await c.prepare(); assert.equal(calls.length, 1)
  const blocked = createController(async command => {throw Error('must not call ' + command)})
  blocked.accept(snapshot(3, 'error', {retryAction: 'install'}))
  await blocked.prepare(); assert.equal(blocked.retryDelay, undefined)
})

await test('install confirmation and active native download suppress all background activity', async () => {
  let calls = 0
  const c = createController(async () => {calls++})
  c.accept(snapshot(1, 'downloaded')); c.act()
  await c.prepare(); assert.equal(c.confirming, true); assert.equal(calls, 0)
  c.dismiss(); c.accept(snapshot(2, 'downloading'))
  await c.prepare(); assert.equal(calls, 0)
})

// Tiny DOM fake exercises the actual boot/listen/timer/button wiring, not just
// projections. No additional frontend test framework/runtime dependency needed.
class Element {
  constructor() { this.style = {}; this.hidden = false; this.isConnected = true; this.rect = {left: 10, top: 650, width: 36, height: 42}; this.listeners = {}; this.attributes = {}; this.classes = new Set(); this.classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) } }
  getBoundingClientRect() { this.rectReads = (this.rectReads ?? 0) + 1; return this.rect }
  setAttribute(name, value) { this.attributes[name] = value }
  removeAttribute(name) { delete this.attributes[name] }
  addEventListener(name, callback) { this.listeners[name] = callback }
  focus() { this.focused = true }
  remove() { this.removed = true }
  attachShadow() { return this.root = new Root() }
}
class ButtonElement extends Element {}
class ProgressElement extends Element {}
class KeyEvent {
  constructor(key) { this.key = key; this.prevented = false; this.stopped = false }
  preventDefault() { this.prevented = true }
  stopPropagation() { this.stopped = true }
}
class Root extends Element {
  constructor() { super(); this.nodes = new Map() }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, (selector === '.action' ? new ButtonElement() : selector === 'progress' ? new ProgressElement() : new Element())); return this.nodes.get(selector) }
}
async function boot({ configured = true, initial = snapshot(0, 'idle'), statusError = null, slot = null } = {}) {
  const calls = [], timers = [], intervals = [], attached = [], clearedTimers = []
  const frames = new Map()
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()) }
  const observers = []
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this) }
    observe(target) { this.targets.push(target) }
    disconnect() { this.targets = [] }
  }
  let currentSlot = slot
  let listener, unlistened = false, pagehide
  const dom = { visibilityState: 'visible', body: { append: node => attached.push(node) }, createElement: () => new Element(), getElementById: () => currentSlot }
  let remote = initial
  let disconnected = false
  const win = {
    innerWidth: 1254, innerHeight: 768,
    requestAnimationFrame: callback => {frames.set(1, callback); return 1},
    cancelAnimationFrame: id => frames.delete(id),
    __TAURI__: {
      core: { invoke: async (command, args) => { calls.push([command, args]); if (disconnected) throw new Error('IPC disconnected'); if (command === 'desktop_status') { if (statusError) throw new Error(statusError); return { updaterConfigured: configured } }; return remote } },
      event: { listen: async (_name, callback) => { listener = callback; return () => { unlistened = true } } },
    },
    setTimeout: (callback, delay) => { callback.delay = delay; timers.push(callback); return timers.length },
    setInterval: callback => { intervals.push(callback); return 2 },
    clearTimeout: timer => { if (timer !== undefined) clearedTimers.push(timer) }, clearInterval: () => {},
    addEventListener: (name, callback) => { if (name === 'pagehide') pagehide = callback },
    removeEventListener: () => {},
  }
  vm.runInNewContext(source, { window: win, document: dom, HTMLElement: Element, HTMLButtonElement: ButtonElement, HTMLProgressElement: ProgressElement, KeyboardEvent: KeyEvent, ResizeObserver: Observer, MutationObserver: Observer })
  await new Promise(resolve => setImmediate(resolve))
  return { host: attached[0], calls, timers, intervals, clearedTimers, disconnect: () => { disconnected = true }, observers, setSlot: value => { currentSlot = value; observers[1].callback(); flushFrames() }, resize: () => { observers[0].callback(); flushFrames() }, mutate: () => { observers[1].callback(); flushFrames() }, setRemote: value => { remote = value }, emit: value => listener?.({ payload: value }), exit: () => pagehide(), get unlistened() { return unlistened } }
}

await test('real DOM bridge shows left blue icon, safe notes, confirmation and closes without install', async () => {
  const b = await boot()
  assert.match(b.host.style.cssText, /left:11px/)
  assert.match(b.host.style.cssText, /bottom:104px/)
  assert.match(b.host.style.cssText, /z-index:11/, 'Content/composer < updater < shared shell overlays')
  assert.equal(b.host.hidden, false)
  assert.equal(b.host.root.querySelector('.panel').hidden, true)
  b.emit(snapshot(1, 'available', { notes: '<img src=x onerror=alert(1)>' }))
  const $ = s => b.host.root.querySelector(s)
  assert.equal($('.toggle').classes.has('primary'), true)
  assert.equal($('.panel').hidden, true)
  assert.equal($('.notes').textContent, '<img src=x onerror=alert(1)>')
  $('.toggle').listeners.click()
  assert.equal($('.panel').hidden, false)
  b.setRemote(snapshot(2, 'downloaded'))
  await $('.action').listeners.click()
  assert.equal($('.action').textContent, '重启更新')
  await $('.action').listeners.click()
  assert.equal($('.confirm').hidden, false)
  const escape = new KeyEvent('Escape')
  b.host.root.listeners.keydown(escape)
  assert.equal(escape.prevented, true)
  assert.equal(escape.stopped, true, 'Escape must not close an unrelated app surface behind the updater')
  assert.equal($('.confirm').hidden, true)
  assert.equal($('.panel').hidden, true)
  assert.equal(b.calls.some(([command]) => command === 'desktop_install_update'), false)
  b.exit()
  assert.equal(b.unlistened, true)
})

await test('sidebar reserves a real footer row, tracks resize/remount and releases observers', async () => {
  const slot = new Element(); slot.hidden = true; slot.parentElement = new Element()
  const b = await boot({slot})
  assert.equal(slot.hidden, false)
  assert.equal(slot.style.cssText, 'height:42px;flex:none;width:100%')
  assert.equal(b.host.style.top, '654px')
  assert.equal(b.host.style.bottom, 'auto')
  const reads = slot.rectReads
  b.mutate(); b.mutate()
  assert.equal(slot.rectReads, reads, 'Streaming message mutations do not trigger layout reads')
  slot.rect.top = 600; slot.rect.left = 12; b.resize()
  assert.equal(b.host.style.top, '604px'); assert.equal(b.host.style.left, '13px')
  assert.equal(b.host.root.querySelector('.panel').style.maxHeight, '576px')
  slot.isConnected = false
  const replacement = new Element(); replacement.rect.top = 580
  b.setSlot(replacement)
  assert.equal(slot.hidden, true); assert.equal(replacement.hidden, false)
  assert.equal(b.host.style.top, '584px')
  replacement.isConnected = false; b.setSlot(null)
  assert.equal(b.host.style.top, 'auto'); assert.equal(b.host.style.bottom, '104px')
  b.setSlot(replacement)
  b.exit()
  assert.equal(replacement.hidden, true)
  assert.ok(b.observers.every(observer => observer.targets.length === 0))
})

await test('late sidebar mounting is adopted; plain web/unconfigured bridge reserves no row', async () => {
  const b = await boot(); const slot = new Element()
  b.setSlot(slot)
  assert.equal(b.host.style.top, '654px')
  const unusedSlot = new Element(); unusedSlot.hidden = true
  const unavailable = await boot({configured: false, slot: unusedSlot})
  assert.equal(unusedSlot.hidden, true)
  assert.ok(unavailable.observers.every(observer => observer.targets.length === 0))
})

await test('unconfigured builds hide updater and do not check network', async () => {
  const b = await boot({ configured: false })
  assert.equal(b.host.hidden, true)
  assert.deepEqual(b.calls.map(c => c[0]), ['desktop_status'])
  assert.equal(b.timers.length, 0)
})

await test('offline automatic check does not force open a panel', async () => {
  const b = await boot()
  b.setRemote(snapshot(1, 'error', { retryAction: 'check', message: 'offline' }))
  await b.timers[0]()
  assert.equal(b.host.root.querySelector('.panel').hidden, true)
  assert.equal(b.host.root.querySelector('.text').textContent, 'offline')
})

await test('boot timer prepares update without opening panel and pagehide prevents new requests', async () => {
  const b = await boot()
  b.setRemote(snapshot(1, 'available'))
  await b.timers[0]()
  assert.deepEqual(b.calls.map(([command]) => command), ['desktop_status', 'desktop_update_status', 'desktop_check_update', 'desktop_download_update'])
  assert.equal(b.host.root.querySelector('.panel').hidden, true)
  b.exit(); const count = b.calls.length
  await b.intervals[0](); assert.equal(b.calls.length, count)
})

await test('IPC failures without a native sequence still schedule all bounded retries', async () => {
  const b = await boot()
  b.disconnect()
  await b.timers[0]()
  for (const [index, delay] of [[1, 30_000], [2, 120_000], [3, 600_000]]) {
    assert.equal(b.timers[index].delay, delay)
    await b.timers[index]()
  }
  assert.equal(b.timers.length, 4)
  assert.equal(b.calls.filter(([command]) => command === 'desktop_check_update').length, 4)
  await b.intervals[0]()
  assert.equal(b.timers.length, 4)
  assert.equal(b.host.root.querySelector('.panel').hidden, true)
  b.exit()
})

await test('successful preparation clears stale retry timers without scheduling an installation', async () => {
  const b = await boot()
  b.setRemote(snapshot(1, 'error', { retryAction: 'download', message: 'offline' }))
  await b.timers[0]()
  assert.equal(b.timers[1].delay, 30_000)
  b.emit(snapshot(2, 'downloaded'))
  assert.ok(b.clearedTimers.includes(2))
  assert.equal(b.calls.some(([command]) => command === 'desktop_install_update'), false)
  b.exit()
})

await test('native ACL boot failures remain inspectable without offering installation', async () => {
  const b = await boot({ statusError: 'Command desktop_status not allowed by ACL' })
  const $ = s => b.host.root.querySelector(s)
  assert.equal(b.host.hidden, false)
  assert.equal($('.panel').hidden, true)
  $('.toggle').listeners.click()
  assert.equal($('.panel').hidden, false)
  assert.match($('.text').textContent, /not allowed by ACL/)
  assert.equal($('.action').disabled, true)
  assert.equal($('.action').textContent, '更新不可用')
  assert.deepEqual(b.calls.map(c => c[0]), ['desktop_status'])
  assert.equal(b.timers.length, 0)
})

const capability = JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/capabilities/desktop-main.json', import.meta.url), 'utf8'))
const appBuild = await readFile(new URL('../apps/desktop/src-tauri/build.rs', import.meta.url), 'utf8')
for (const command of ['desktop_status', 'desktop_check_update', 'desktop_update_status', 'desktop_download_update', 'desktop_install_update']) {
  assert.ok(appBuild.includes('"' + command + '"'), 'application manifest missing ' + command)
  assert.ok(capability.permissions.includes('allow-' + command.replaceAll('_', '-')), 'loopback capability missing ' + command)
}
assert.deepEqual(capability.webviews, ['main'])
assert.equal(capability.windows, undefined, 'window-wide ACL would grant browser child views desktop commands')
assert.deepEqual(capability.remote.urls, ['http://127.0.0.1:*'])

const config = JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
assert.equal(typeof config.plugins?.updater?.pubkey, 'string')
assert.equal(config.bundle.createUpdaterArtifacts, true)
if (process.env.UI_TEST_SCRIPT_ONLY !== '1') {
const built = await readFile(scriptAssetDist('desktop-updater.js'), 'utf8')
assert.equal(built, source, 'checked-in Web bundle must contain current updater')
const index = await readFile(scriptAssetDist('index.html'), 'utf8')
const updaterRev = createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex').slice(0, 16)
assert.ok(index.includes('/desktop-updater.js?rev=' + updaterRev), 'updater cache revision must match shipped source')
}
console.log(assertions + ' desktop updater tests passed; ' + (process.env.UI_TEST_SCRIPT_ONLY === '1' ? 'batch unit/config only (bundle freshness not accepted)' : 'bundle/config verified'))
