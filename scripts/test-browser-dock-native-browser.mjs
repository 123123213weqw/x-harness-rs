import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
// Exercise the real AppFrame with Tauri present: expand right if the monitor
// has room, otherwise borrow width from the conversation on the left.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  // The headless viewport covers the largest simulated native width so the
  // expanded controls remain clickable; innerWidth is mocked separately.
  const page = await browser.newPage({ viewport: { width: 2000, height: 780 } })
  const errors = []
  page.on('pageerror', error => {if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  await installOwnedViewHtml(page,process.env.UI_TEST_IMPL??'canonical','<html><head></head><body style="margin:0"><div id="root" style="position:fixed;left:0;top:0;width:1280px;height:780px"></div></body></html>')
  await page.addScriptTag({ content: `
    window.__ModuleLoader__={load:x=>{window.registrations??={};registrations[x.id]=x}};
    window.nativeSize={width:1280,height:780};
    window.nativeResizeCalls=0;
    window.monitorWidth=2000;
    Object.defineProperty(window,'innerWidth',{configurable:true,get:()=>window.nativeSize.width});
    window.__TAURI__={window:{
      LogicalSize:class {constructor(width,height){this.width=width;this.height=height}},
      currentMonitor:async()=>({workArea:{position:{x:0,y:0},size:{width:window.monitorWidth,height:1200}}}),
      getCurrentWindow:()=>({
        innerSize:async()=>({...window.nativeSize}),
        outerSize:async()=>({...window.nativeSize}),
        outerPosition:async()=>({x:100,y:50}),
        scaleFactor:async()=>1,
        isMaximized:async()=>false,
        isFullscreen:async()=>false,
        setSize:async size=>{window.nativeResizeCalls++;window.nativeSize={width:size.width,height:size.height};document.getElementById('root').style.width=size.width+'px';window.dispatchEvent(new Event('resize'))},
      }),
    }};
  ` })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xharness/dsh-client-ui-layout') })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xlang/xharness-client-ui-browser') })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xharness/dsh-client-runtime') })
  await page.evaluate(() => {
    const engine=registrations['@xharness/dsh-client-runtime'].factory(id=>{if(id in staticModules)return staticModules[id];throw Error(id)})
    const runtime=id=>{if(id==='@xharness/dsh-client-runtime/client')return engine;if(id in staticModules)return staticModules[id];throw Error(id)}
    const layout = registrations['@xharness/dsh-client-ui-layout'].factory(runtime)
    const plugin = registrations['@xlang/xharness-client-ui-browser'].factory(runtime)
    let AppFrame,rootDefinition
    layout.apply({ effect: (fn, label) => { if (label.includes('service')) fn() }, reflect: { provide: () => () => {} }, slots: { register: (spec, component) => { rootDefinition=spec;AppFrame = component; return () => {} } } })
    const instance=rootDefinition.store().create(),actions=instance.actions;rootDefinition.inject(actions)
    const slots = (name, props) => name === 'shell.overlay' ? null
      : name === 'workspace.item' ? React.createElement(plugin.BrowserPane, props)
      : name === 'conversation' ? React.createElement('div', { style: { position: 'absolute', top: 8, right: 8 } }, React.createElement(plugin.BrowserToggle))
      : React.createElement('div', null, name)
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    root.render(React.createElement(AppFrame, {
      useStore:selector=>selector(React.useSyncExternalStore(instance.subscribe,instance.getSnapshot)),
      useSessions: selector => selector({ current: undefined, byId: {} }), actions, renderSlot: slots,
    }))
  })
  const center = () => page.locator('._84hhiq_centerCol').evaluate(element => element.getBoundingClientRect().width)
  const original = await center()
  await page.getByRole('button', { name: '展开右侧工作区' }).click()
  await page.waitForFunction(() => document.querySelector('[data-xhworkspace-open]:not([data-xhworkspace-drawer])') && window.nativeSize.width === 1720)
  await page.waitForFunction(() => document.querySelector('._84hhiq_centerCol').getBoundingClientRect().width === 1000)
  assert.equal(await center(), original, 'roomy screen grows right and preserves the conversation')
  assert.equal(await page.locator('._84hhiq_detailsCol').evaluate(element => element.getBoundingClientRect().width), 440)
  assert.equal(await page.evaluate(() => window.nativeResizeCalls), 1, 'roomy screen expands the OS window once')
  await page.evaluate(()=>document.fonts.ready);const initialPixelsSha256=createHash('sha256').update(await page.locator('#root').screenshot({animations:'disabled'})).digest('hex')
  // Native resize and the divider's CSS left transition settle separately
  // in WebKit. Wait for its hit target, not only the grid column width.
  await page.waitForFunction(() => {
    const handle = document.querySelector('._84hhiq_handle[data-side="details"]').getBoundingClientRect()
    const panel = document.querySelector('._84hhiq_detailsCol').getBoundingClientRect()
    return Math.abs(handle.x + handle.width / 2 - panel.x) < 0.5
  })
  const handle = await page.locator('._84hhiq_handle[data-side="details"]').boundingBox()
  const dragX = handle.x + handle.width / 2
  const dragY = handle.y + 120
  await page.mouse.move(dragX, dragY)
  await page.mouse.down()
  await page.mouse.move(dragX - 60, dragY, { steps: 4 })
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector('._84hhiq_detailsCol').getBoundingClientRect().width === 500)
  assert.equal(await center(), original - 60, 'dragging grows leftward into chat, even after native right expansion')
  assert.equal(await page.evaluate(() => window.nativeSize.width), 1720, 'dragging does not grow native window again')
  await page.getByRole('button', { name: '关闭 新标签页' }).click()
  await page.waitForFunction(() => document.querySelector('[data-xhworkspace-open]') === null && window.nativeSize.width === 1280)
  assert.equal(await center(), original, 'closing restores original chat layout')
  await page.evaluate(() => { window.monitorWidth = 1300 })
  await page.getByRole('button', { name: '展开右侧工作区' }).click()
  await page.waitForFunction(() => {
    const frame = document.querySelector('[data-xhworkspace-open]:not([data-xhworkspace-drawer])')
    return frame && frame.querySelector('._84hhiq_detailsCol').getBoundingClientRect().width === 500
  })
  assert.equal(await page.evaluate(() => window.nativeSize.width), 1280, 'screen-edge fallback leaves native window unchanged')
  assert.equal(await center(), original - 500, 'screen-edge fallback borrows chat width instead of covering it')
  await page.getByRole('button', { name: '关闭 新标签页' }).click()
  await page.waitForFunction(() => document.querySelector('[data-xhworkspace-open]') === null)
  assert.equal(await center(), original, 'closing the fallback dock restores chat width')
  await page.evaluate(() => root.unmount())
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({engine,implementation:process.env.UI_TEST_IMPL??'canonical',actualPlatform:true,actualRuntimeEngine:true,initialPixelsSha256,pageErrors:errors}))
  console.log(`${engine}: adaptive native browser dock passed`)
} finally { await browser.close() }
