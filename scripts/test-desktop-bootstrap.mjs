import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const html = readFileSync(new URL('../apps/desktop/frontend/index.html', import.meta.url), 'utf8')
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1]
async function boot(startupError, eventFirst = false) {
  const classes = new Set(), message = { textContent: '' }
  const main = { classList: { add: name => classes.add(name) } }
  const calls = []
  vm.runInNewContext(source, {
    document: { querySelector: id => id === '#state' ? main : message },
    window: { __TAURI__: {
      event: { listen: async (_name, handler) => { calls.push('listen'); if (eventFirst) handler({ payload: { phase: 'failed', message: 'live lock conflict' } }) } },
      core: { invoke: async command => { calls.push(command); return { startupError } } },
    } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['listen', 'desktop_status'])
  return { classes, message }
}
const missed = await boot('state directory already owned')
assert.ok(missed.classes.has('failed'))
assert.equal(missed.message.textContent, 'state directory already owned')
const live = await boot(null, true)
assert.ok(live.classes.has('failed'))
assert.equal(live.message.textContent, 'live lock conflict')
assert.equal((await boot(null)).classes.has('failed'), false)
console.log('Bootstrap regression passed: missed and live errors do not leave a loading spinner.')
