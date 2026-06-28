// Mock only the Tauri boundary; exercise the shipped React browser pane.
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
  const page = await browser.newPage({ viewport: { width: 960, height: 700 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<html><body style="margin:0"><div id="root" style="width:600px;height:500px"></div><div data-shell-overlay="true"></div></body></html>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
  }
  await page.addScriptTag({ content: `
    window.commands=[];window.listeners=[];
    window.__TAURI__={core:{invoke:async(command,args)=>{commands.push({command,args})}},event:{listen:async(_name,fn)=>{listeners.push(fn);return()=>{listeners=listeners.filter(x=>x!==fn)}}}};
    window.__ModuleLoader__={load:x=>window.registration=x};
  ` })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/dist/plugins/@xlang/xharness-client-ui-browser/client.js', import.meta.url), 'utf8') })
  await page.evaluate(() => {
    const plugin = registration.factory(id => id === 'react' ? React : {})
    const components = {}
    plugin.apply({
      effect: fn => fn(),
      slots: { inject: (_name, fn) => fn(), register: (config, component) => { components[config.id] = component } },
    })
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    function App() {
      const [item, setItem] = React.useState({ id: 'browser:1', kind: 'browser', entries: [], position: -1, title: '新标签页' })
      return React.createElement(components['browser-pane'], { item, open: true, onUpdate: patch => setItem(value => ({ ...value, ...patch })), onClose: () => {}, onNewBrowser: () => {} })
    }
    root.render(React.createElement(App))
  })
  await page.getByRole('textbox', { name: '网址' }).fill('example.com')
  await page.getByRole('textbox', { name: '网址' }).press('Enter')
  await page.waitForFunction(() => commands.some(call => call.command === 'desktop_browser_navigate'))
  const commands = await page.evaluate(() => window.commands)
  const bounds = commands.find(call => call.command === 'desktop_browser_bounds')
  assert.ok(bounds.args.bounds.width > 100 && bounds.args.bounds.height > 100)
  assert.equal(commands.find(call => call.command === 'desktop_browser_navigate').args.url, 'https://example.com/')
  assert.equal(await page.getByText('网页版不能嵌入 example.com').count(), 0, 'desktop mode must not show Web-only fallback')
  await page.evaluate(() => listeners.forEach(fn => fn({ payload: { tabId: 'browser:1', kind: 'url', value: 'https://example.com/next' } })))
  await page.waitForFunction(() => document.querySelector('input[aria-label="网址"]')?.value === 'https://example.com/next')
  await page.getByRole('button', { name: '后退' }).click()
  await page.waitForFunction(() => commands.some(call => call.command === 'desktop_browser_action' && call.args.action === 'back'))
  await page.evaluate(() => {
    const dialog = document.createElement('div'); dialog.role = 'dialog'; dialog.textContent = 'A modal'; document.querySelector('[data-shell-overlay]').append(dialog)
  })
  await page.waitForFunction(() => commands.some(call => call.command === 'desktop_browser_activate' && call.args.tabId === null))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('xharness:browser-close', { detail: { id: 'browser:1' } })))
  await page.waitForFunction(() => commands.some(call => call.command === 'desktop_browser_close'))
  await page.evaluate(() => root.unmount())
  assert.deepEqual(errors, [])
  console.log(`${engine}: native browser bridge passed`)
} finally { await browser.close() }
