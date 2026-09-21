import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../ui/desktop/startup.js', import.meta.url), 'utf8')

function fixture({ desktop = true, mounted = false } = {}) {
  const calls = []
  const frames = []
  const listeners = new Map()
  const root = { childElementCount: mounted ? 1 : 0 }
  let observer
  class MutationObserver {
    constructor(callback) { this.callback = callback; observer = this }
    observe() { this.observing = true }
    disconnect() { this.observing = false }
  }
  const context = {
    Promise,
    MutationObserver,
    requestAnimationFrame: callback => { frames.push(callback) },
    document: {
      readyState: 'complete',
      querySelector: selector => selector === '#root' ? root : null,
      addEventListener: (name, callback) => listeners.set(name, callback),
    },
    window: desktop ? {
      __TAURI__: { core: { invoke: async (command, args) => calls.push([command, args]) } },
    } : {},
  }
  vm.runInNewContext(source, context)
  return {
    calls,
    frames,
    root,
    mutate() { observer?.callback() },
  }
}

const browser = fixture({ desktop: false, mounted: true })
assert.deepEqual(browser.calls, [])
assert.deepEqual(browser.frames, [])

const late = fixture()
assert.deepEqual(late.calls, [])
late.root.childElementCount = 1
late.mutate()
await new Promise(resolve => setImmediate(resolve))
assert.equal(JSON.stringify(late.calls), JSON.stringify([[
  'desktop_report_startup_phase',
  { phase: 'frontend_hydrated' },
]]))
assert.equal(late.frames.length, 1)
late.frames.shift()()
assert.equal(late.frames.length, 1)
late.frames.shift()()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(late.calls.map(call => call[1].phase), ['frontend_hydrated', 'first_frame'])

// Further mutations and frames cannot duplicate a milestone.
late.mutate()
assert.deepEqual(late.calls.map(call => call[1].phase), ['frontend_hydrated', 'first_frame'])

const early = fixture({ mounted: true })
await new Promise(resolve => setImmediate(resolve))
assert.equal(early.calls[0][1].phase, 'frontend_hydrated')
console.log('Desktop startup milestones are desktop-only, ordered and idempotent.')
