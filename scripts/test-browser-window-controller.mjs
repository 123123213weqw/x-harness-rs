import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../ui/overrides/browser-window-controller.js', import.meta.url), 'utf8')
const desktopCapability = JSON.parse(readFileSync(new URL('../apps/desktop/src-tauri/capabilities/desktop-main.json', import.meta.url), 'utf8'))
assert.ok(desktopCapability.permissions.includes('core:window:allow-set-size'), 'desktop bridge permits native right expansion')
const create = vm.runInNewContext(`${source}\nxhCreateBrowserWindowController`)
assert.equal(await create(undefined).set(true, 440), 0, 'ordinary Web cannot resize its host window')

function fixture({ scale = 1, windowWidth = 1000, rightEdge = 1800, maximized = false } = {}) {
  const state = {
    size: { width: windowWidth * scale, height: 700 * scale },
    position: { x: 100 * scale, y: 60 * scale },
    calls: [],
    maximized,
  }
  const current = {
    innerSize: async () => ({ ...state.size }),
    outerSize: async () => ({ ...state.size }),
    outerPosition: async () => ({ ...state.position }),
    scaleFactor: async () => scale,
    isMaximized: async () => state.maximized,
    isFullscreen: async () => false,
    setSize: async size => {
      state.calls.push({ width: size.width, height: size.height })
      state.size.width = size.width * scale
      state.size.height = size.height * scale
    },
  }
  const tauri = { window: {
    getCurrentWindow: () => current,
    currentMonitor: async () => ({ workArea: { position: { x: 0, y: 0 }, size: { width: rightEdge * scale, height: 1200 * scale } } }),
    LogicalSize: class { constructor(width, height) { this.width = width; this.height = height } },
  } }
  return { state, controller: create(tauri) }
}

{
  const { state, controller } = fixture()
  assert.equal(await controller.set(true, 440), 440)
  assert.equal(state.size.width, 1440, 'window right edge grows while original content width remains')
  assert.equal(await controller.set(false), 0)
  assert.equal(state.size.width, 1000, 'closing restores original window width')
  assert.equal(state.calls.length, 2)
}
{
  const { state, controller } = fixture({ scale: 2 })
  assert.equal(await controller.set(true, 440), 440)
  assert.equal(state.size.width, 2880, 'logical window width maps to physical size at 2x scale')
  await controller.set(false)
  assert.equal(state.size.width, 2000)
}
{
  const { state, controller } = fixture({ rightEdge: 1250 })
  assert.equal(await controller.set(true, 440), 0, 'insufficient space uses a drawer')
  assert.equal(state.calls.length, 0, 'drawer fallback does not shrink or move the window')
}
{
  const { state, controller } = fixture({ maximized: true })
  assert.equal(await controller.set(true), 0)
  assert.equal(state.calls.length, 0)
}
{
  const { state, controller } = fixture()
  await controller.set(true, 440)
  state.size.width = 1500 // User resized the window after the dock opened.
  await controller.set(false)
  assert.equal(state.size.width, 1500, 'closing must not undo a manual resize')
}
{
  const { state, controller } = fixture()
  const opening = controller.set(true, 440)
  const closing = controller.set(false)
  assert.equal(await opening, 440)
  assert.equal(await closing, 0)
  assert.equal(state.size.width, 1000, 'serialized open/close cannot leave the window widened')
}
console.log('browser window expansion controller passed')
