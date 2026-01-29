import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../ui/desktop/updater.js', import.meta.url), 'utf8')
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

// Tiny DOM fake exercises the actual boot/listen/timer/button wiring, not just
// projections. No additional frontend test framework/runtime dependency needed.
class Element {
  constructor() { this.style = {}; this.hidden = false; this.listeners = {}; this.attributes = {}; this.classes = new Set(); this.classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) } }
  setAttribute(name, value) { this.attributes[name] = value }
  removeAttribute(name) { delete this.attributes[name] }
  addEventListener(name, callback) { this.listeners[name] = callback }
  focus() { this.focused = true }
  remove() { this.removed = true }
  attachShadow() { return this.root = new Root() }
}
class Root extends Element {
  constructor() { super(); this.nodes = new Map() }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector) }
}
async function boot({ configured = true, initial = snapshot(0, 'idle'), statusError = null } = {}) {
  const calls = [], timers = [], intervals = [], attached = []
  let listener, unlistened = false, pagehide
  const dom = { visibilityState: 'visible', body: { append: node => attached.push(node) }, createElement: () => new Element() }
  let remote = initial
  const win = {
    __TAURI__: {
      core: { invoke: async (command, args) => { calls.push([command, args]); if (command === 'desktop_status') { if (statusError) throw new Error(statusError); return { updaterConfigured: configured } }; return remote } },
      event: { listen: async (_name, callback) => { listener = callback; return () => { unlistened = true } } },
    },
    setTimeout: callback => { timers.push(callback); return 1 },
    setInterval: callback => { intervals.push(callback); return 2 },
    clearTimeout: () => {}, clearInterval: () => {},
    addEventListener: (name, callback) => { if (name === 'pagehide') pagehide = callback },
  }
  vm.runInNewContext(source, { window: win, document: dom })
  await new Promise(resolve => setImmediate(resolve))
  return { host: attached[0], calls, timers, intervals, setRemote: value => { remote = value }, emit: value => listener?.({ payload: value }), exit: () => pagehide(), get unlistened() { return unlistened } }
}

await test('real DOM bridge shows left blue icon, safe notes, confirmation and closes without install', async () => {
  const b = await boot()
  assert.match(b.host.style.cssText, /left:11px/)
  assert.match(b.host.style.cssText, /bottom:64px/)
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
  b.host.root.listeners.keydown({ key: 'Escape' })
  assert.equal($('.confirm').hidden, true)
  assert.equal($('.panel').hidden, true)
  assert.equal(b.calls.some(([command]) => command === 'desktop_install_update'), false)
  b.exit()
  assert.equal(b.unlistened, true)
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
assert.deepEqual(capability.windows, ['main'])
assert.deepEqual(capability.remote.urls, ['http://127.0.0.1:*'])

const config = JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
assert.equal(typeof config.plugins?.updater?.pubkey, 'string')
assert.equal(config.bundle.createUpdaterArtifacts, true)
const built = await readFile(new URL('../ui/dist/desktop-updater.js', import.meta.url), 'utf8')
assert.equal(built, source, 'checked-in Web bundle must contain current updater')
console.log(assertions + ' desktop updater tests passed, plus bundle/config checks')
