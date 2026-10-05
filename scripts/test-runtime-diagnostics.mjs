import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync(new URL('../apps/desktop/frontend/diagnostics.js', import.meta.url), 'utf8')
const elements = new Map()
const get = id => {
  if (!elements.has(id)) elements.set(id, { disabled: false, checked: false, hidden: false, textContent: '', classList: { add() {}, remove() {} }, addEventListener(_event, handler) { this.click = handler } })
  return elements.get(id)
}
let state = { available: true, hostRunning: false, previousAbnormalExit: true, version: 'test', platform: 'windows', deepRemainingSeconds: 0 }
let failExport = false
const calls = []
vm.runInNewContext(source, {
  document: { getElementById: get }, setInterval() {},
  window: { __TAURI__: { core: { invoke: async (command, args) => {
    calls.push({ command, args })
    if (command === 'desktop_diagnostics_status') return state
    if (command === 'desktop_export_diagnostics') { if (failExport) throw Error('disk full'); return 'D:/diagnostics/export.json' }
    if (command === 'desktop_set_deep_diagnostics') state = { ...state, deepActive: args.enabled, deepPersistent: args.enabled && args.persistent, fullMemory: args.enabled && args.fullMemory, heapCheck: args.enabled && args.heapCheck, deepRemainingSeconds: args.enabled && !args.persistent ? 900 : 0 }
    if (command === 'desktop_diagnostics_acknowledge') state = { ...state, previousAbnormalExit: false }
  } } } },
})
const tick = () => new Promise(resolve => setImmediate(resolve))
await tick()
assert.equal(get('incident').hidden, false)
assert.match(get('status').textContent, /后台未运行/)
assert.equal(calls.length, 1, 'opening diagnosis must not restart a Host or retry tools')
await get('enable').click(); await tick()
assert.equal(calls.filter(c => c.command === 'desktop_set_deep_diagnostics').length, 0, 'requires consent')
get('consent').checked = true
await get('enable').click(); await tick()
assert.match(get('deep-status').textContent, /15 分钟/)
await get('disable').click(); await tick()
assert.match(get('deep-status').textContent, /已关闭/)
get('persistent').checked = true
get('full-memory').checked = true
await get('enable').click(); await tick()
assert.match(get('deep-status').textContent, /持续开启/)
assert.equal(get('disable').disabled, false, 'persistent mode can be disabled despite zero remaining seconds')
assert.equal(get('full-memory').checked, true)
assert.equal(get('persistent').disabled, true)
await get('disable').click(); await tick()
assert.equal(state.deepPersistent, false)
assert.equal(state.fullMemory, false)
assert.match(get('deep-status').textContent, /已关闭/)
await get('export').click(); await tick()
assert.match(get('output').textContent, /已保存到/)
failExport = true
await get('export').click(); await tick()
assert.doesNotMatch(get('output').textContent, /已保存到/)
assert.match(get('output').textContent, /操作失败/)
await get('acknowledge').click(); await tick()
assert.equal(get('incident').hidden, true)
assert.ok(calls.every(c => !/restart|session|tool|install_update/.test(c.command)))
const capability = JSON.parse(readFileSync(new URL('../apps/desktop/src-tauri/capabilities/diagnostics.json', import.meta.url)))
assert.equal(capability.remote, undefined, 'deep control and export must not be granted to remote pages')
assert.deepEqual(capability.windows, ['diagnostics'])
console.log('Runtime diagnostics UI: consent, state restoration, export failures and no-replay checks passed')

// Native lifecycle routing: retained history must not become an automatic notice.
const desktop = readFileSync(new URL('../apps/desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8')
const updater = readFileSync(new URL('../apps/desktop/src-tauri/src/updater.rs', import.meta.url), 'utf8')
const sidecar = readFileSync(new URL('../apps/desktop/src-tauri/src/sidecar.rs', import.meta.url), 'utf8')
assert.match(desktop, /diagnostics\s*\.previous_run_interrupted\(\)/)
assert.doesNotMatch(desktop, /diagnostics\.incident\(\)/)
assert.match(updater, /state\.diagnostics\.finish\(\);\s*app\.restart\(\)/)
const startFailure = sidecar.slice(sidecar.indexOf('if let Err(error) = &result'), sidecar.indexOf('async fn start_claimed'))
assert.doesNotMatch(startFailure, /diagnostics::open/)
assert.match(sidecar, /let was_ready = !event_startup_pending\.load\(Ordering::SeqCst\);/)
assert.match(sidecar, /!state\.closing\.load\(Ordering::SeqCst\) && was_ready[\s\S]*?diagnostics::open_automatically/)
assert.match(sidecar, /wait_until_product_ready[\s\S]*?startup_pending\.store\(false, Ordering::SeqCst\)/)
console.log('Runtime diagnostics lifecycle routing: clean restart, history and startup failures passed')

assert.ok(updater.includes('.on_before_exit(app.state::<DesktopState>().diagnostics.update_exit_hook())'), 'Windows direct installer exit owns a clean boundary')
assert.ok(updater.includes('state.diagnostics.resume_after_failed_update();'), 'failed Windows installer restores crash detection')
