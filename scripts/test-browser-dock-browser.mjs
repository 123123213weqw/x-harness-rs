// Isolated regression of the shipped AppFrame browser dock, no Rust Host required.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { patchBrowserDock } from './patch-browser-dock.mjs'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const layoutSource = readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-layout/client.js', import.meta.url), 'utf8')
  assert.equal(patchBrowserDock(Buffer.from(layoutSource)).toString(), layoutSource, 'dock rebuild patch is idempotent')
  const page = await browser.newPage({ viewport: { width: 1280, height: 780 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<html><head></head><body style="margin:0"><div id="root" style="position:fixed;inset:0"></div></body></html>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
  }
  await page.addScriptTag({ content: 'window.__ModuleLoader__={load:x=>{window.registrations??={};registrations[x.id]=x}}' })
  await page.addScriptTag({ content: layoutSource })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/plugins/@xlang/xharness-client-ui-browser/client.js', import.meta.url), 'utf8') })
  await page.evaluate(() => {
    const runtime = id => {
      if (id === 'react') return React
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => React.createElement(type, props), jsxs: (type, props) => React.createElement(type, props), Fragment: React.Fragment }
      if (id === '@xharness/dsh-client-runtime/client') return { defineStore: spec => spec }
      return {}
    }
    const layout = registrations['@xharness/dsh-client-ui-layout'].factory(runtime)
    const browser = registrations['@xlang/xharness-client-ui-browser'].factory(runtime)
    let AppFrame
    layout.apply({
      effect: (fn, label) => { if (label.includes('service')) fn() },
      reflect: { provide: (_name, service) => { window.layoutService = service; return () => {} } },
      slots: { register: (_, component) => { AppFrame = component; return () => {} } },
    })
    const actions = { setNarrow: () => {}, openDetails: () => {}, closeDetails: () => {}, setSidebar: () => {}, setDetails: () => {} }
    window.layoutActions = actions
    const slots = (name, props) => {
      if (name === 'shell.overlay') return null
      if (name === 'workspace.item') return React.createElement(browser.BrowserPane, props)
      if (name === 'conversation') return React.createElement('div', { style: { position: 'absolute', top: 8, right: 8 } }, React.createElement(browser.BrowserToggle))
      return React.createElement('div', null, name)
    }
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    root.render(React.createElement(AppFrame, {
      useStore: selector => selector({ sidebar: 280, details: 0, narrowExpanded: false }),
      useSessions: selector => selector({ current: undefined, byId: {} }), actions, renderSlot: slots,
    }))
  })
  const centerBefore = await page.locator('._84hhiq_centerCol').evaluate(element => element.getBoundingClientRect().width)
  await page.getByRole('button', { name: '展开右侧工作区' }).click()
  await page.getByRole('region', { name: '工作区' }).waitFor()
  await page.waitForTimeout(400)
  const wide = await page.evaluate(() => {
    const frame = document.querySelector('[data-xhworkspace-open]')
    return {
      center: frame.querySelector('._84hhiq_centerCol').getBoundingClientRect().width,
      browser: frame.querySelector('._84hhiq_detailsCol').getBoundingClientRect().width,
      drawer: Boolean(frame.dataset.xhworkspaceDrawer),
    }
  })
  assert.equal(wide.drawer, false, 'a wide window docks the browser even without native outward expansion')
  assert.equal(wide.center, centerBefore - 440, 'internal dock shares width with the conversation')
  assert.equal(wide.browser, 440, JSON.stringify(wide))
  assert.equal(await page.locator('._84hhiq_centerCol').evaluate(el => getComputedStyle(el).zIndex),
    await page.locator('._84hhiq_detailsCol').evaluate(el => getComputedStyle(el).zIndex),
    'chat and browser are peer stacking contexts in dock mode')
  // Global UI must paint above both peers, including the browser's local menus.
  const assertShellAboveBrowser = async () => {
    await page.getByRole('button', { name: '更多浏览器操作', exact: true }).click()
    await page.evaluate(() => {
      const card = document.createElement('button')
      card.dataset.testid = 'global-menu'; card.textContent = 'Global model menu'
      card.style.cssText = 'position:absolute;right:30px;top:75px;width:160px;height:100px;background:white'
      card.onclick = () => { window.globalMenuClicked = true }
      document.querySelector('[data-shell-overlay]').append(card)
    })
    const visible = await page.getByTestId('global-menu').evaluate(element => {
      const r = element.getBoundingClientRect()
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === element
    })
    assert.equal(visible, true, 'shell overlays must win hit testing over browser chrome and drawer')
    await page.getByTestId('global-menu').click()
    assert.equal(await page.evaluate(() => window.globalMenuClicked), true)
    await page.evaluate(() => document.querySelector('[data-testid="global-menu"]').remove())
    await page.getByRole('button', { name: '更多浏览器操作', exact: true }).click()
  }
  await assertShellAboveBrowser()
  const dragHandle = page.locator('._84hhiq_handle[data-side="details"]')
  const drag = async delta => {
    const box = await dragHandle.boundingBox()
    const x = box.x + box.width / 2
    const y = box.y + 120
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + delta, y, { steps: 4 })
    await page.mouse.up()
  }
  await drag(60)
  assert.equal(await page.locator('._84hhiq_detailsCol').evaluate(element => element.getBoundingClientRect().width), 440,
    'dragging right cannot shrink the browser dock')
  await drag(-60)
  await page.waitForFunction(() => document.querySelector('._84hhiq_detailsCol').getBoundingClientRect().width === 500)
  await drag(40)
  assert.equal(await page.locator('._84hhiq_detailsCol').evaluate(element => element.getBoundingClientRect().width), 500,
    'an expanded dock cannot be collapsed rightward by dragging')
  await page.getByRole('textbox', { name: '网址' }).fill('example.com')
  await page.getByRole('textbox', { name: '网址' }).press('Enter')
  await page.evaluate(() => { layoutService.attachPanels(layoutActions); layoutService.openDetails() })
  await page.getByRole('tab', { name: '工具详情' }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 2, 'tool details and browser share one tab strip')
  await page.getByRole('tab', { name: 'example.com' }).click()
  assert.equal(await page.getByRole('textbox', { name: '网址' }).inputValue(), 'https://example.com/')
  await page.getByRole('textbox', { name: '网址' }).fill('example.org')
  await page.getByRole('textbox', { name: '网址' }).press('Enter')
  await page.getByRole('tab', { name: 'example.org' }).waitFor()
  await page.getByRole('button', { name: '后退' }).click()
  await page.getByRole('tab', { name: 'example.com' }).waitFor()
  await page.getByRole('tab', { name: '工具详情' }).click()
  await page.getByText('details').waitFor()
  await page.evaluate(() => layoutService.closeDetails())
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 1)
  assert.equal(await page.getByRole('tab').count(), 1, 'upstream tool close removes only its tab')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('xharness:workspace-open', {
    detail: { kind: 'file', source: '/workspace/notes.md' },
  })))
  await page.getByRole('tab', { name: 'notes.md' }).waitFor()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('xharness:workspace-open', {
    detail: { kind: 'file', source: '/workspace/notes.md' },
  })))
  assert.equal(await page.getByRole('tab').count(), 2, 'same file source reuses its workspace tab')
  await page.getByRole('tab', { name: 'example.com' }).click()
  await page.getByRole('button', { name: '关闭 notes.md' }).click()
  await page.setViewportSize({ width: 700, height: 780 })
  await page.waitForFunction(() => document.querySelector('[data-xhworkspace-drawer]') !== null)
  assert.equal(await page.getByRole('button', { name: '关闭工作区' }).count(), 1, 'drawer adds a dismissible scrim')
  await assertShellAboveBrowser()
  await page.getByRole('button', { name: '关闭工作区' }).click({ position: { x: 20, y: 20 } })
  await page.getByRole('region', { name: '工作区' }).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '展开右侧工作区' }).click()
  assert.equal(await page.getByRole('textbox', { name: '网址' }).inputValue(), '', 'closing a tab discards its local navigation state')
  await page.evaluate(() => root.unmount())
  assert.deepEqual(errors, [])
  console.log(`${engine}: browser layout fallback passed`)
} finally { await browser.close() }
