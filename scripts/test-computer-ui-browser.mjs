import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { assertRebuildInput } from './fixtures/repository-ui-input.mjs'

const dependencies = process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const dist = resolve(process.env.UI_TEST_DIST ?? new URL('../ui/dist/', import.meta.url).pathname)
const id = '@xlang/xharness-client-ui-computer'
const bytes = readFileSync(resolve(dist, 'plugins', id, 'client.js'))
const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json'), 'utf8'))
const entry = graph.entries.find(row => row.id === id)
assert.ok(entry, 'canonical ModuleLoader graph includes computer UI')
assert.equal(entry.rev, createHash('sha256').update(bytes).digest('hex').slice(0, 16))
assert.match(bytes.toString(), /^\/\/ Generated from src\/modules\/computer\/index\.tsx;/)
assert.equal(assertRebuildInput(id).kind, 'source-module', 'browser runs the strict repository source input, not frozen ui/plugins')
const require = createRequire(resolve(dependencies, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<main id="root"></main>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(dependencies, 'node_modules', file) })
  }
  await page.addScriptTag({ content: `window.__ModuleLoader__={load(value){window.__computerRegistration=value}}` })
  await page.addScriptTag({ content: bytes.toString() })
  await page.evaluate(() => {
    const registration = window.__computerRegistration
    const plugin = registration.factory(id => {
      if (id === 'react') return window.React
      if (id === 'react/jsx-runtime') {
        const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key })
        return { jsx, jsxs: jsx, Fragment: React.Fragment }
      }
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

  // In the desktop shell the native cross-app panel replaces the DOM pill.
  // Start/stop calls are serialized so transport jitter cannot resurrect a
  // completed activity.
  await page.evaluate(() => {
    window.__nativeActivityCalls = []
    window.__TAURI__ = { core: { invoke(command, args) {
      window.__nativeActivityCalls.push({ command, args })
      return Promise.resolve()
    } } }
    const host = document.createElement('div')
    document.body.appendChild(host)
    window.__nativeComputerRoot = ReactDOM.createRoot(host)
    window.__nativeComputerRoot.render(React.createElement(window.__computerTest.Row, {
      callId: 'native-call',
      block: { name: 'computer', argsRaw: JSON.stringify({ action: 'click', x: 40, y: 80, frame_id: 'mac-frame-2' }) },
      t: window.__computerTest.t,
    }))
  })
  await page.waitForFunction(() => window.__nativeActivityCalls.length === 1)
  assert.equal(await indicator.isHidden(), true)
  assert.deepEqual(await page.evaluate(() => window.__nativeActivityCalls[0]), {
    command: 'desktop_set_computer_activity',
    args: { request: { callId: 'native-call', active: true, mode: 'control', text: 'XHarness 正在控制鼠标和键盘' } },
  })
  await page.evaluate(() => {
    window.__nativeComputerRoot.render(React.createElement(window.__computerTest.Row, {
      callId: 'native-call',
      block: {
        kind: 'tool-result',
        call: { argsRaw: JSON.stringify({ action: 'click', x: 40, y: 80, frame_id: 'mac-frame-2' }) },
        content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'click' }) }],
        isError: false,
      },
      t: window.__computerTest.t,
    }))
  })
  await page.waitForFunction(() => window.__nativeActivityCalls.length === 2)
  assert.deepEqual(await page.evaluate(() => window.__nativeActivityCalls[1].args.request), {
    callId: 'native-call', active: false, mode: '', text: '',
  })
  assert.equal(await indicator.isHidden(), true)
  await page.evaluate(() => window.__nativeComputerRoot.unmount())
  assert.deepEqual(errors, [], 'canonical computer UI must not emit browser exceptions')
  console.log(`${engine}: canonical source ModuleLoader Computer row, privacy indicator, settled summary, navigation retention and serialized native start/stop passed; browser errors []`)
} finally {
  await browser.close()
}
