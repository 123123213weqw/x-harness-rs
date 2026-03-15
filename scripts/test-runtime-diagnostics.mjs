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
    if (command === 'desktop_set_deep_diagnostics') state = { ...state, deepRemainingSeconds: args.enabled ? 900 : 0 }
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
