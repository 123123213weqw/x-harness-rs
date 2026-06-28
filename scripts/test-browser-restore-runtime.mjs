// End-to-end layout/plugin restoration against the stable native snapshot IPC.
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
  await page.setContent('<html><body style="margin:0"><div id="root" style="position:fixed;inset:0"></div></body></html>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
  }
  await page.addScriptTag({ content: `
    window.commands=[];
    window.__TAURI__={core:{invoke:async(command,args)=>{
      commands.push({command,args});
      if(command==='desktop_browser_restore') return JSON.stringify({__global__:{activeId:'browser:7',items:[{id:'browser:7',kind:'browser',title:'example.com',entries:['https://example.com/'],position:0}]}});
      if(command==='desktop_browser_activate') return false;
    }},event:{listen:async()=>()=>{}}};
    window.__ModuleLoader__={load:x=>{window.registrations??={};registrations[x.id]=x}};
  ` })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-layout/client.js', import.meta.url), 'utf8') })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/dist/plugins/@xlang/xharness-client-ui-browser/client.js', import.meta.url), 'utf8') })
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
    const components = {}
    plugin.apply({ effect: fn => fn(), slots: { inject: (_, fn) => fn(), register: (config, component) => { components[config.id] = component } } })
    const actions = { setNarrow() {}, closeDetails() {}, setSidebar() {}, setDetails() {} }
    const slots = (name, props) => name === 'workspace.item' ? React.createElement(components['browser-pane'], props)
      : name === 'conversation' ? React.createElement('div', null, 'Conversation') : null
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    root.render(React.createElement(AppFrame, {
      useStore: selector => selector({ sidebar: 280, details: 0, narrowExpanded: false }),
      useSessions: selector => selector({ current: undefined, byId: {} }), actions, renderSlot: slots,
    }))
  })
  await page.getByRole('tab', { name: 'example.com' }).waitFor()
  await page.waitForFunction(() => commands.some(call => call.command === 'desktop_browser_navigate'))
  const commands = await page.evaluate(() => window.commands)
  assert.equal(commands.find(call => call.command === 'desktop_browser_navigate').args.url, 'https://example.com/')
  assert.ok(commands.some(call => call.command === 'desktop_browser_restore'))
  await page.evaluate(() => root.unmount())
  assert.deepEqual(errors, [])
  console.log(`${engine}: stable native browser snapshot restored into workspace`)
} finally { await browser.close() }
