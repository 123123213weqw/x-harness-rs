import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dependencies = process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests'
const require = createRequire(resolve(dependencies, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setContent('<main id="root"></main>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(dependencies, 'node_modules', file) })
  }
  await page.addScriptTag({ content: `window.__ModuleLoader__={load(value){window.__computerRegistration=value}}` })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/plugins/@xlang/xharness-client-ui-computer/client.js', import.meta.url), 'utf8') })
  await page.evaluate(() => {
    const registration = window.__computerRegistration
    const plugin = registration.factory(id => {
      if (id === 'react') return window.React
      throw new Error(`unexpected module dependency: ${id}`)
    })
    let Row
    const dictionaries = {}
    plugin.apply({
      effect(run) { run() },
      locale: { register(namespace, values) { dictionaries[namespace] = values } },
      slots: {
        inject(_name, run) { run() },
        register(_config, component) { Row = component },
      },
    })
    const copy = dictionaries['xharness-computer'].zh
    const t = (key, values = {}) => (copy[key] ?? key).replace('{count}', String(values.count ?? ''))
    window.__computerTest = {
      Row,
      t,
      root: ReactDOM.createRoot(document.getElementById('root')),
      render(block, callId = 'computer-call') {
        this.root.render(React.createElement(this.Row, { callId, block, t: this.t, inspect() { window.__inspected = true } }))
      },
    }
  })

  await page.evaluate(() => window.__computerTest.render({
    name: 'computer',
    argsRaw: JSON.stringify({ action: 'observe' }),
  }))
  const indicator = page.locator('.xh-computer-privacy')
  await assert.doesNotReject(() => indicator.waitFor({ state: 'visible' }))
  assert.equal(await indicator.textContent(), 'XHarness 正在查看屏幕')
  assert.equal(await indicator.getAttribute('data-mode'), 'view')
  assert.match(await page.locator('.xh-computer-card').textContent(), /电脑操作.*正在查看屏幕.*进行中/)

  await page.evaluate(() => window.__computerTest.render({
    kind: 'tool-result',
    call: { argsRaw: JSON.stringify({ action: 'observe' }) },
    content: [{ type: 'text', text: JSON.stringify({
      action: 'observe',
      accessibility: { nodes: [{}, {}, {}] },
      surfaces: [{}],
      screenshot_included: true,
    }) }],
    isError: false,
  }))
  await page.waitForFunction(() => document.querySelector('.xh-computer-privacy')?.hidden === true)
  assert.match(await page.locator('.xh-computer-summary').textContent(), /3 个控件.*1 个窗口.*含屏幕截图/)

  await page.evaluate(() => window.__computerTest.render({
    name: 'computer',
    argsRaw: JSON.stringify({ action: 'click', node_id: 'ax:42:w1:0', frame_id: 'mac-frame-1' }),
  }, 'control-call'))
  await page.waitForFunction(() => document.querySelector('.xh-computer-privacy')?.dataset.mode === 'control')
  assert.equal(await indicator.textContent(), 'XHarness 正在控制鼠标和键盘')
  await page.locator('.xh-computer-main').click()
  assert.match(await page.locator('.xh-computer-detail').textContent(), /点击控件.*ax:42:w1:0.*mac-frame-1/)
  await page.locator('.xh-computer-inspect').click()
  assert.equal(await page.evaluate(() => window.__inspected), true)

  // Navigating away must not hide an operation that may still control the OS.
  await page.evaluate(() => window.__computerTest.root.unmount())
  assert.equal(await indicator.isVisible(), true)
  console.log(`${engine}: Computer row, global privacy indicator, settled summary and navigation retention passed`)
} finally {
  await browser.close()
}
