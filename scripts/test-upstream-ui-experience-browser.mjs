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
  page.on('pageerror', error => console.error('browser page error:', error))
  await page.setContent(`<style>:root{--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-border-l2:#d4d4d4;--dsw-alias-bg-base:#fff;--dsw-alias-interactive-bg-hover:#eee;--dsw-alias-markdown-code-block:#f7f7f7}body{font:14px system-ui;margin:24px}#root,#diff{max-width:820px}#diff{margin-top:30px}</style><main id="root"></main><div id="diff"></div>`)
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(dependencies, 'node_modules', file) })
  }
  await page.addScriptTag({ content: `window.__ModuleLoader__={load(value){window.__experienceRegistration=value}}` })
  await page.addScriptTag({ content: readFileSync(new URL('../ui/plugins/@xlang/xharness-client-ui-experience/client.js', import.meta.url), 'utf8') })
  await page.evaluate(() => {
    const plugin = window.__experienceRegistration.factory(id => {
      if (id === 'react') return React
      throw new Error(`unexpected module dependency ${id}`)
    })
    let Settings
    const dictionaries = {}
    plugin.apply({
      effect(run) { run() },
      locale: { register(id, values) { dictionaries[id] = values }, bind(id) { return key => dictionaries[id].zh[key] || key } },
      slots: { inject(_name, run) { run() }, register(_config, component) { Settings = component } },
    })
    window.__experienceTest = { plugin, root: ReactDOM.createRoot(document.getElementById('root')) }
    window.__experienceTest.root.render(React.createElement(Settings, { t: key => dictionaries['xharness-experience'].zh[key] || key }))
  })
  await page.locator('.xhe-option').nth(2).click({ timeout: 5000 }).catch(async error => { console.error(await page.locator('#root').innerHTML()); throw error })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.xhProcessMode), 'detailed')
  await page.locator('.xhe-search').fill('聚焦')
  assert.equal(await page.locator('.xhe-shortcut').count(), 1)
  await page.locator('.xhe-key').click()
  await page.keyboard.press('Control+Shift+Y')
  assert.equal(await page.locator('.xhe-key').textContent(), 'Mod+Shift+Y')
  await page.getByRole('button', { name: '恢复默认' }).click()
  assert.equal(await page.locator('.xhe-key').textContent(), 'Mod+Shift+L')
  await page.locator('.xhe-option').first().click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.xhProcessMode), 'compact')
  if (engine === 'chromium') await page.locator('#root').screenshot({ path: '/tmp/xh-experience-settings.png' })

  const review = readFileSync(new URL('../ui/overrides/review-diff.js', import.meta.url), 'utf8')
  await page.addScriptTag({ content: `document.documentElement.lang='zh'; var react=window.React; var _xharness_dsh_client_ui_primitives={DiffBlock:({diffs})=>React.createElement('pre',{className:'fake-inline'},diffs[0].newText)}; ${review}\nwindow.__Review=XHReviewDiffBlock;` })
  await page.evaluate(() => {
    window.__diffRoot = ReactDOM.createRoot(document.getElementById('diff'))
    window.__diffRoot.render(React.createElement(window.__Review, { diffs: [{ path: 'example.txt', oldText: 'one\ntwo\n', newText: 'one\nthree\n' }] }))
  })
  assert.equal(await page.locator('.fake-inline').textContent(), 'one\nthree\n')
  await page.getByRole('button', { name: '并排' }).click()
  assert.equal(await page.locator('.xh-review-pane').count(), 2)
  assert.equal(await page.locator('.xh-review-line[data-changed="true"]').count(), 2)
  assert.equal(await page.locator('.xh-review-path').textContent(), 'example.txt')
  if (engine === 'chromium') await page.locator('#diff').screenshot({ path: '/tmp/xh-experience-diff.png' })
  await page.getByRole('button', { name: '行内' }).click()
  assert.equal(await page.locator('.fake-inline').count(), 1)
  console.log(`${engine} upstream UI experience browser tests passed`)
} finally {
  await browser.close()
}
