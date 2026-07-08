// Browser content is one workspace item; workspace owns the surrounding tabs.
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
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<html><head></head><body><div id="root"></div></body></html>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js'])
    await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
  await page.addScriptTag({ content: 'window.__ModuleLoader__={load:x=>window.registration=x}' })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/plugins/@xlang/xharness-client-ui-browser/client.js', import.meta.url), 'utf8') })
  await page.evaluate(() => {
    const api = registration.factory(id => id === 'react' ? React : {})
    window.api = api
    const components = {}
    const ctx = {
      effect: fn => fn(),
      slots: { inject: (_name, fn) => fn(), register: (config, component) => { components[config.id] = component } },
    }
    api.apply(ctx)
    if (components['browser-edge']) throw Error('legacy right-edge browser trigger must not be registered')
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    function App() {
      const [item, setItem] = React.useState({ id: 'browser:1', kind: 'browser', entries: [], position: -1, title: '新标签页' })
      const [open, setOpen] = React.useState(true)
      const [created, setCreated] = React.useState(0)
      return React.createElement(React.Fragment, null,
        React.createElement(components['browser-toggle']),
        React.createElement('div', { id: 'created' }, created),
        open && React.createElement(components['browser-pane'], { item, open: true,
          onUpdate: patch => setItem(value => ({ ...value, ...patch })),
          onClose: () => setOpen(false), onNewBrowser: () => setCreated(value => value + 1) }))
    }
    root.render(React.createElement(App))
  })
  const expand = page.getByRole('button', { name: '展开右侧工作区' })
  await expand.waitFor()
  assert.equal(await expand.innerText(), '', 'top-right workspace trigger must be icon-only')
  assert.equal(await expand.locator('svg').count(), 1)
  assert.equal(await expand.locator('svg').getAttribute('width'), '14', 'expand glyph should match the header icon scale')
  assert.equal(await expand.locator('svg').getAttribute('viewBox'), '0 0 16 16')
  assert.equal(await page.evaluate(() => api.normalizeAddress('example.com:8080').url), 'https://example.com:8080/')
  assert.equal(await page.getByText('浏览器', { exact: true }).count(), 0, 'do not show a vertical browser label')
  assert.equal(await page.getByRole('tab').count(), 0, 'browser content must not create nested tabs')
  const toolbar = page.locator('.xhbrowser-toolbar')
  assert.deepEqual(await toolbar.locator(':scope > *').evaluateAll(nodes => nodes.map(node => node.className)),
    ['xhbrowser-nav', 'xhbrowser-annotate', 'xhbrowser-address-form', 'xhbrowser-actions', 'xhbrowser-more'])
  assert.equal(await page.getByRole('button', { name: '标注（尚未接入）' }).isDisabled(), true, 'preview must not imply annotation is implemented')
  await page.getByRole('button', { name: '下载记录' }).click()
  await page.getByRole('region', { name: '下载记录' }).getByText('网页版没有内置下载记录。').waitFor()
  await page.getByRole('button', { name: '下载记录' }).click()
  await page.getByRole('textbox', { name: '网址' }).fill('example.com')
  await page.getByRole('textbox', { name: '网址' }).press('Enter')
  await page.getByText('网页版不能嵌入 example.com').waitFor()
  assert.equal(await page.getByRole('link', { name: '在系统浏览器打开' }).last().getAttribute('href'), 'https://example.com/')
  assert.equal(await page.locator('iframe').count(), 0, 'preview must not pretend to be a full browser')
  await page.getByRole('textbox', { name: '网址' }).fill('example.org')
  await page.getByRole('textbox', { name: '网址' }).press('Enter')
  await page.getByRole('button', { name: '后退' }).click()
  await page.waitForFunction(() => document.querySelector('input[aria-label="网址"]')?.value === 'https://example.com/')
  await page.getByRole('button', { name: '前进' }).click()
  await page.waitForFunction(() => document.querySelector('input[aria-label="网址"]')?.value === 'https://example.org/')
  await page.getByRole('textbox', { name: '网址' }).fill('javascript:alert(1)')
  await page.getByRole('textbox', { name: '网址' }).press('Enter')
  await page.getByRole('alert').filter({ hasText: '仅支持' }).waitFor()
  await page.keyboard.press('Control+t')
  await page.waitForFunction(() => document.querySelector('#created')?.textContent === '1')
  await page.keyboard.press('Escape')
  await page.getByRole('textbox', { name: '网址' }).waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log(`${engine}: browser workspace item passed`)
} finally { await browser.close() }
