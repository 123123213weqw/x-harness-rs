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
assert.match(sidecar, /open_ui\(app, endpoint.clone\(\), address, &mut budget\)\.await\?;\s*startup_pending\.store\(false, Ordering::SeqCst\)/)
assert.match(sidecar, /wait_until_product_ready\(app, address, budget\)\.await\?;[\s\S]*?startup\.host_ready/)
const exitGate = readFileSync(new URL('../apps/desktop/src-tauri/src/desktop_exit.rs', import.meta.url), 'utf8')
assert.match(exitGate, /match crate::sidecar::graceful_stop\(&handle\)\.await/)
assert.match(exitGate, /Err\(_\) => \{[\s\S]*?DesktopExitBlocked[\s\S]*?closing\.store\(false/)
assert.doesNotMatch(exitGate.slice(exitGate.indexOf('Err(_) => {'), exitGate.indexOf('/// Keep ordinary')), /force_stop|\.exit\(/)
console.log('Runtime diagnostics lifecycle routing: clean restart, history and startup failures passed')

assert.ok(updater.includes('.on_before_exit(app.state::<DesktopState>().diagnostics.update_exit_hook())'), 'Windows direct installer exit owns a clean boundary')
assert.ok(updater.includes('state.diagnostics.resume_after_failed_update();'), 'failed Windows installer restores crash detection')

const lostStream = sidecar.slice(sidecar.indexOf('if !terminated'), sidecar.indexOf('let (endpoint, address'))
assert.match(lostStream, /host_job\.terminate\(1\)/)
assert.match(lostStream, /active_processes == 0[\s\S]*?running\.store\(false, Ordering::SeqCst\)/)
assert.match(lostStream, /Instant::now\(\) >= deadline/)

// Separate cold production builds from the unchanged release stress harness.
// Both jobs remain required, fatal and bounded; no stress workload is reduced.
const workflow=readFileSync(new URL('../.github/workflows/runtime-diagnostics.yml',import.meta.url),'utf8')
const savePolicy="save-if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/master' }}"
const validationCondition="if: ${{ github.event_name != 'push' && !inputs.desktop_bundle }}"
const hostBuild='cargo build --locked --release -p xharness-host-app -p xharness-sandbox --bins'
function jobBlock(text,name){
 const lines=text.split('\n'),start=lines.indexOf('  '+name+':')
 assert.notEqual(start,-1,'missing required job '+name)
 let end=start+1
 while(end<lines.length&&!/^  [\w-]+:/.test(lines[end]))end++
 return lines.slice(start,end).join('\n')
}
function nativeValidationPolicy(text){
 const native=jobBlock(text,'native'),host=jobBlock(text,'windows-host-repro')
 for(const block of [native,host]){
  assert.match(block,/timeout-minutes: 20(?:\n|$)/,'keep the original twenty-minute job deadline')
  assert.ok(block.includes(validationCondition),'both validation jobs must run for the same events')
  assert.ok(block.includes(savePolicy),'PR cache uploads must remain disabled')
  assert.doesNotMatch(block,/continue-on-error|if:\s*false/,'validation failures remain fatal')
  assert.ok(block.includes('actions/checkout@v6'),'each workload checks out the exact workflow source')
 }
 assert.doesNotMatch(host,/^    needs:/m,'independent artifact compilation must not serialize stress execution')
 assert.ok(host.includes('runs-on: windows-2025')&&host.includes('CARGO_BUILD_TARGET: x86_64-pc-windows-msvc'),'keep native Windows build target')
 assert.ok(host.includes(hostBuild),'keep the complete production Host/sandbox build')
 assert.ok(host.includes('diagnostics-windows-host-symbols')&&host.includes('release/xharness-host.exe')&&host.includes('release/xharness_host.pdb')&&host.includes('if-no-files-found: error'),'retain the matching required Host/PDB artifact')
 assert.ok(!native.includes(hostBuild),'production Host build must not consume the stress job deadline')
 for(const required of ['cargo test --locked -p xharness-diagnostics -p xharness-debug -p xharness-win32','cargo clippy --locked -p xharness-diagnostics -p xharness-debug -p xharness-win32 --all-targets -- -D warnings','Validate real native EXE/PDB identity parser','Retain offline projection test'])assert.ok(native.includes(required),'missing mandatory gate '+required)
 for(const name of ['offline_reasoning_projection_stress','offline_journal_projection_stress','offline_authoritative_restore_100_cold_starts','offline_dynamic_projection_stress']){
  const command='cargo test --locked --release -p xharness-host '+name+' -- --ignored --nocapture'
  const steps=native.split(/^      - /m).filter(step=>step.includes(command))
  assert.equal(steps.length,1,'missing or changed release stress gate '+name)
  assert.doesNotMatch(steps[0],/^\s+if:/m,'stress must run on both matrix platforms')
 }
}
nativeValidationPolicy(workflow)
assert.throws(()=>nativeValidationPolicy(workflow.replace(savePolicy,'save-if: true')),/PR cache uploads/)
assert.throws(()=>nativeValidationPolicy(workflow.replace('timeout-minutes: 20','timeout-minutes: 40')),/twenty-minute job deadline/)
assert.throws(()=>nativeValidationPolicy(workflow.replace('offline_dynamic_projection_stress','removed_projection_gate')),/release stress gate/)
assert.throws(()=>nativeValidationPolicy(workflow.replace('  windows-host-repro:','  removed-host-job:')),/missing required job/)
assert.throws(()=>nativeValidationPolicy(workflow.replace('release/xharness_host.pdb','release/removed.pdb')),/Host\/PDB artifact/)
assert.throws(()=>nativeValidationPolicy(workflow.replace('cargo test --locked --release -p xharness-host offline_reasoning','cargo test --locked -p xharness-host offline_reasoning')),/release stress gate/)
assert.throws(()=>nativeValidationPolicy(workflow.replace('      - name: Exercise concurrent dynamic append and Host publication','      - name: Exercise concurrent dynamic append and Host publication\n        if: false')),/remain fatal/)
const hostCache=workflow.lastIndexOf(savePolicy)
assert.throws(()=>nativeValidationPolicy(workflow.slice(0,hostCache)+workflow.slice(hostCache).replace(savePolicy,'save-if: true')),/PR cache uploads/)
assert.throws(()=>nativeValidationPolicy(workflow.replace('      - run: cargo test --locked -p xharness-diagnostics','      - run: '+hostBuild+'\n      - run: cargo test --locked -p xharness-diagnostics')),/must not consume the stress job deadline/)
console.log('Runtime diagnostics CI: independent Host/PDB build, unchanged release stress gates/deadlines, read-only PR cache and mutation checks passed')
