import assert from 'node:assert/strict'
import {layoutUnitModuleTestInput} from './fixtures/layout-module-test-input.mjs'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source=layoutUnitModuleTestInput('browser-window-controller.js',['xhCreateBrowserWindowController'])
const desktopCapability = JSON.parse(readFileSync(new URL('../apps/desktop/src-tauri/capabilities/desktop-main.json', import.meta.url), 'utf8'))
let registration
vm.runInNewContext(source,{window:{__ModuleLoader__:{load:row=>{registration=row}}},console})
const create=registration.factory(()=>({})).xhCreateBrowserWindowController
assert.equal(await create(undefined).set(true, 440), 0, 'ordinary Web borrows width on the left')

function fixture({ scale = 1, windowWidth = 1000, rightEdge = 1800, maximized = false } = {}) {
  const state = {
    size: { width: windowWidth * scale, height: 700 * scale },
    position: { x: 100 * scale, y: 60 * scale },
    calls: [], maximized, rightEdge,
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
    currentMonitor: async () => ({ workArea: { position: { x: 0, y: 0 }, size: { width: state.rightEdge * scale, height: 1200 * scale } } }),
    LogicalSize: class { constructor(width, height) { this.width = width; this.height = height } },
  } }
  return { state, controller: create(tauri) }
}

assert.equal(desktopCapability.permissions.includes('core:window:allow-set-size'), true,
  'desktop bridge permits optional right expansion')
{
  const { state, controller } = fixture()
  assert.equal(await controller.set(true, 440), 440)
  assert.equal(state.size.width, 1440, 'roomy screen expands the window rightward')
  assert.equal(await controller.set(false), 0)
  assert.equal(state.size.width, 1000, 'close restores the original window')
  assert.equal(state.calls.length, 2)
}
{
  const { state, controller } = fixture({ rightEdge: 1250 })
  assert.equal(await controller.set(true, 440), 0, 'insufficient room borrows width from chat')
  assert.equal(state.size.width, 1000)
  assert.equal(state.calls.length, 0, 'no partial rightward expansion')
}
{
  const { state, controller } = fixture({ rightEdge: 1540 })
  assert.equal(await controller.set(true, 440), 0, 'eight-pixel screen-edge margin is reserved')
  assert.equal(state.calls.length, 0)
}
{
  const { state, controller } = fixture({ scale: 2 })
  assert.equal(await controller.set(true, 440), 440)
  assert.equal(state.size.width, 2880, 'logical size maps to physical size on HiDPI')
  await controller.set(false)
  assert.equal(state.size.width, 2000)
}
{
  const { state, controller } = fixture({ maximized: true })
  assert.equal(await controller.set(true, 440), 0)
  assert.equal(state.calls.length, 0, 'maximized windows only borrow chat width')
}
{
  const { state, controller } = fixture()
  await controller.set(true, 440)
  state.size.width = 1500 // The user manually resized the window.
  await controller.set(false)
  assert.equal(state.size.width, 1500, 'close must not undo the user resize')
}
{
  const { state, controller } = fixture()
  await controller.set(true, 440)
  state.rightEdge = 1500
  assert.equal(await controller.set(true, 500), 0, 'if more room is needed, restore and borrow from chat')
  assert.equal(state.size.width, 1000)
}
{
  const { state, controller } = fixture()
  const opening = controller.set(true, 440)
  const closing = controller.set(false)
  assert.equal(await opening, 440)
  assert.equal(await closing, 0)
  assert.equal(state.size.width, 1000, 'serialized close cannot leave a late-opened window wide')
}
console.log('adaptive browser window expansion controller passed / '+(process.env.UI_TEST_IMPL??'source')+' / strict production closure')
