import assert from 'node:assert/strict'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {layoutUnitModuleTestInput} from './fixtures/layout-module-test-input.mjs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors=[];page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  await installOwnedViewHtml(page,process.env.UI_TEST_IMPL??'source','<html><body></body></html>')
  const source=layoutUnitModuleTestInput('workspace-pane.js',['xhLoadBrowserSpaces','xhSaveBrowserSpaces','xhNextWorkspaceId'])
  await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>window.registration=row}'})
  await page.addScriptTag({content:source})
  await page.evaluate(()=>{window.browserStorage=registration.factory(name=>{if(name in staticModules)return staticModules[name];if(name==='@xharness/dsh-client-runtime/client')return{};throw Error(name)})})
  const result = await page.evaluate(async () => {
    const spaces = browserStorage.xhLoadBrowserSpaces(JSON.stringify({ session: {
      activeId: 'browser:9', items: [
        { id: 'browser:9', kind: 'browser', title: 'Site', entries: ['https://example.com/', 'javascript:bad'], position: 1 },
        { id: 'tool', kind: 'tool', title: 'Do not persist' },
      ],
    } }))
    window.saved = []
    window.__TAURI__ = { core: { invoke: async (command, args) => saved.push({ command, args }) } }
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw Error('blocked origin storage') }
    try { browserStorage.xhSaveBrowserSpaces(spaces) } finally { Storage.prototype.setItem = original }
    await new Promise(resolve => setTimeout(resolve, 350))
    return { spaces, nextId: browserStorage.xhNextWorkspaceId(spaces), saved }
  })
  assert.equal(result.spaces.session.items.length, 1, 'tool state is not persisted as browser state')
  assert.deepEqual(result.spaces.session.items[0].entries, ['https://example.com/'])
  assert.equal(result.spaces.session.items[0].position, 0)
  assert.equal(result.nextId, 9)
  assert.equal(result.saved[0].command, 'desktop_browser_persist', 'stable app-config persistence must still work when origin storage is blocked')
  assert.equal(JSON.parse(result.saved[0].args.snapshot).session.items.length, 1)
  assert.deepEqual(errors,[])
  console.log(`${engine}: browser tab persistence and blocked origin storage passed / ${process.env.UI_TEST_IMPL??'source'} / strict production closure`)
} finally { await browser.close() }
