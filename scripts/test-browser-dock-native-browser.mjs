// Exercise the real AppFrame with a simulated Tauri window that grows outward.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 780 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<html><head></head><body style="margin:0"><div id="root" style="position:fixed;left:0;top:0;width:1280px;height:780px"></div></body></html>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
  }
  await page.addScriptTag({ content: `
    window.__ModuleLoader__={load:x=>{window.registrations??={};registrations[x.id]=x}};
    window.nativeSize={width:1280,height:780};
    window.__TAURI__={window:{
      LogicalSize:class {constructor(width,height){this.width=width;this.height=height}},
      currentMonitor:async()=>({workArea:{position:{x:0,y:0},size:{width:2000,height:1200}}}),
      getCurrentWindow:()=>({
        innerSize:async()=>({...window.nativeSize}),
        outerSize:async()=>({...window.nativeSize}),
        outerPosition:async()=>({x:100,y:50}),
        scaleFactor:async()=>1,
        isMaximized:async()=>false,
        isFullscreen:async()=>false,
        setSize:async size=>{window.nativeSize={width:size.width,height:size.height};document.getElementById('root').style.width=size.width+'px'},
      }),
    }};
  ` })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-layout/client.js', import.meta.url), 'utf8') })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/plugins/@xlang/xharness-client-ui-browser/client.js', import.meta.url), 'utf8') })
  await page.evaluate(() => {
    const runtime = id => {
      if (id === 'react') return React
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => React.createElement(type, props), jsxs: (type, props) => React.createElement(type, props), Fragment: React.Fragment }
      if (id === '@xharness/dsh-client-runtime/client') return { defineStore: spec => spec }
      return {}
    }
    const layout = registrations['@xharness/dsh-client-ui-layout'].factory(runtime)
    const plugin = registrations['@xlang/xharness-client-ui-browser'].factory(runtime)
    let AppFrame
    layout.apply({ effect: (fn, label) => { if (label.includes('service')) fn() }, reflect: { provide: () => () => {} }, slots: { register: (_, component) => { AppFrame = component; return () => {} } } })
    const actions = { setNarrow: () => {}, closeDetails: () => {}, setSidebar: () => {}, setDetails: () => {} }
    const slots = (name, props) => name === 'shell.overlay' ? null
      : name === 'workspace.item' ? React.createElement(plugin.BrowserPane, props)
      : name === 'conversation' ? React.createElement('div', { style: { position: 'absolute', top: 8, right: 8 } }, React.createElement(plugin.BrowserToggle))
      : React.createElement('div', null, name)
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    root.render(React.createElement(AppFrame, {
      useStore: selector => selector({ sidebar: 280, details: 0, narrowExpanded: false }),
      useSessions: selector => selector({ current: undefined, byId: {} }), actions, renderSlot: slots,
    }))
  })
  const center = () => page.locator('._84hhiq_centerCol').evaluate(element => element.getBoundingClientRect().width)
  const original = await center()
  await page.getByRole('button', { name: '展开右侧工作区' }).click()
  await page.waitForFunction(() => window.nativeSize.width === 1720 && document.querySelector('[data-xhworkspace-open]:not([data-xhworkspace-drawer])'))
  await page.setViewportSize({ width: 1720, height: 780 }) // Native WebView viewport follows its outer window.
  assert.equal(await center(), original, 'native outward expansion must preserve chat width')
  assert.equal(await page.locator('._84hhiq_detailsCol').evaluate(element => element.getBoundingClientRect().width), 440)
  await page.getByRole('button', { name: '关闭 新标签页' }).click()
  await page.waitForFunction(() => window.nativeSize.width === 1280)
  await page.setViewportSize({ width: 1280, height: 780 })
  assert.equal(await center(), original, 'closing restores original chat layout')
  await page.evaluate(() => root.unmount())
  assert.deepEqual(errors, [])
  console.log(`${engine}: native right-expanding browser layout passed`)
} finally { await browser.close() }
