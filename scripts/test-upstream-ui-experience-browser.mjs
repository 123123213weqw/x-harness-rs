import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {exposeModuleUnit} from './fixtures/module-unit-scope.mjs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dependencies = process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const require = createRequire(resolve(dependencies, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors=[];page.on('pageerror', error => {if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  await installOwnedViewHtml(page,process.env.UI_TEST_IMPL??'canonical',`<style>:root{--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-border-l2:#d4d4d4;--dsw-alias-bg-base:#fff;--dsw-alias-interactive-bg-hover:#eee;--dsw-alias-markdown-code-block:#f7f7f7}body{font:14px system-ui;margin:24px}#root,#diff{max-width:820px}#diff{margin-top:30px}</style><main id="root"></main><div id="reasoning"><div data-variant="think" data-state="ok"><span class="U8JO7q_separator">·</span><span class="U8JO7q_summary">Past reasoning</span></div><div data-variant="think" data-state="running"><span class="U8JO7q_separator">·</span><span class="U8JO7q_summary">Current reasoning</span></div></div><div id="diff"></div>`)
  await page.addScriptTag({ content: `window.__ModuleLoader__={load(value){window.__experienceRegistration=value}}` })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xlang/xharness-client-ui-experience') })
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
  assert.equal(await page.locator('.xhe-option').count(), 2)
  await page.locator('.xhe-option').nth(1).click({ timeout: 5000 }).catch(async error => { console.error(await page.locator('#root').innerHTML()); throw error })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.xhProcessMode), 'expanded')
  await page.locator('.xhe-search').fill('聚焦')
  assert.equal(await page.locator('.xhe-shortcut').count(), 1)
  await page.locator('.xhe-key').click()
  await page.keyboard.press('Control+Shift+Y')
  assert.equal(await page.locator('.xhe-key').textContent(), 'Mod+Shift+Y')
  await page.getByRole('button', { name: '恢复默认' }).click()
  assert.equal(await page.locator('.xhe-key').textContent(), 'Mod+Shift+L')
  await page.locator('.xhe-option').first().click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.xhProcessMode), 'auto')
  assert.notEqual(await page.locator('#reasoning [data-state="ok"]').evaluate(element => getComputedStyle(element).display), 'none')
  assert.notEqual(await page.locator('#reasoning [data-state="running"]').evaluate(element => getComputedStyle(element).display), 'none')
  assert.notEqual(await page.locator('#reasoning [data-state="running"] .U8JO7q_separator').evaluate(element => getComputedStyle(element).display), 'none')
  await page.locator('.xhe-option').nth(1).click()
  assert.notEqual(await page.locator('#reasoning [data-state="ok"]').evaluate(element => getComputedStyle(element).display), 'none')
  await page.locator('.xhe-option').first().click()
  const migration = await page.evaluate(() => {
    const test = __experienceTest.plugin._test
    const values = {}
    for (const old of ['compact','standard','detailed','verbose','auto','expanded','invalid']) {
      localStorage.setItem(test.MODE_KEY, old); values[old] = test.initialMode()
    }
    localStorage.removeItem(test.MODE_KEY); values.missing = test.initialMode()
    test.setMode('auto')
    return values
  })
  assert.deepEqual(migration,{compact:'auto',standard:'auto',detailed:'auto',verbose:'expanded',auto:'auto',expanded:'expanded',invalid:'auto',missing:'auto'})
  await page.keyboard.press('Control+Shift+J')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.xhProcessMode), 'expanded')
  await page.keyboard.press('Control+Shift+J')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.xhProcessMode), 'auto')
  if (engine === 'chromium') await page.locator('#root').screenshot({ path: '/tmp/xh-experience-settings.png' })

  const review=exposeModuleUnit(ownedViewModuleTestInput('@xharness/dsh-client-ui-tool'),'tool','tool/components/ReviewDiffBlock','XHReviewDiffBlock')
  await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>window.runtimeRegistration=row}'})
  await page.addScriptTag({content:ownedViewModuleTestInput('@xharness/dsh-client-runtime')})
  await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>window.reviewRegistration=row}'})
  await page.addScriptTag({content:review})
  await page.evaluate(()=>{
    document.documentElement.lang='zh'
    const runtime=runtimeRegistration.factory(name=>staticModules[name])
    window.__Review=reviewRegistration.factory(name=>{if(name==='@xharness/dsh-client-runtime/client')return runtime;if(name in staticModules)return staticModules[name];throw Error(name)}).XHReviewDiffBlock
  })
  await page.evaluate(() => {
    window.__diffRoot = ReactDOM.createRoot(document.getElementById('diff'))
    window.__diffRoot.render(React.createElement(window.__Review, { diffs: [{ path: 'example.txt', oldText: 'one\ntwo\n', newText: 'one\nthree\n' }] }))
  })
  await page.locator('#diff [data-diff]').waitFor()
  assert.deepEqual(await page.locator('#diff [data-diff]').locator('div[class*=line]').allTextContents(),['example.txt','one','two','one','three'],'actual inline DiffBlock retains both old and new text')
  await page.getByRole('button', { name: '并排' }).click()
  assert.equal(await page.locator('.xh-review-pane').count(), 2)
  assert.equal(await page.locator('.xh-review-line[data-changed="true"]').count(), 2)
  assert.equal(await page.locator('.xh-review-path').textContent(), 'example.txt')
  if (engine === 'chromium') await page.locator('#diff').screenshot({ path: '/tmp/xh-experience-diff.png' })
  await page.getByRole('button', { name: '行内' }).click()
  assert.equal(await page.locator('#diff [data-diff]').count(),1)
  assert.equal(await page.locator('#diff [data-diff]').getByText('three',{exact:true}).count(),1)
  assert.deepEqual(errors,[])
  console.log(`${engine} upstream UI experience browser tests passed (actual platform singleton)`)
} finally {
  await browser.close()
}
