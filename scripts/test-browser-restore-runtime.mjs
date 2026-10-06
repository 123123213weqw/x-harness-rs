import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
// End-to-end layout/plugin restoration against the stable native snapshot IPC.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 780 } })
  const errors = []
  page.on('pageerror', error => {if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  await installOwnedViewHtml(page,process.env.UI_TEST_IMPL??'canonical','<html><body style="margin:0"><div id="root" style="position:fixed;inset:0"></div></body></html>')
  await page.addScriptTag({ content: `
    window.commands=[];window.activeTab=null;window.nativeTabs=new Set();
    window.__TAURI__={core:{invoke:async(command,args)=>{
      commands.push({command,args});
      if(command==='desktop_browser_restore') return JSON.stringify({__global__:{activeId:'browser:7',items:[{id:'browser:7',kind:'browser',title:'example.com',entries:['https://example.com/'],position:0}]}});
      if(command==='desktop_browser_activate'){activeTab=args.tabId;return nativeTabs.has(args.tabId)}
      if(command==='desktop_browser_navigate'){nativeTabs.add(args.tabId);activeTab=args.tabId}
    }},event:{listen:async()=>()=>{}}};
    window.__ModuleLoader__={load:x=>{window.registrations??={};registrations[x.id]=x}};
  ` })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xharness/dsh-client-ui-layout') })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xlang/xharness-client-ui-browser') })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xharness/dsh-client-runtime') })
  await page.evaluate(() => {
    const engine=registrations['@xharness/dsh-client-runtime'].factory(id=>{if(id in staticModules)return staticModules[id];throw Error(id)})
    const runtime=id=>{if(id==='@xharness/dsh-client-runtime/client')return engine;if(id in staticModules)return staticModules[id];throw Error(id)}
    const layout = registrations['@xharness/dsh-client-ui-layout'].factory(runtime)
    const plugin = registrations['@xlang/xharness-client-ui-browser'].factory(runtime)
    let AppFrame,rootDefinition
    layout.apply({ effect: (fn, label) => { if (label.includes('service')) fn() }, reflect: { provide: () => () => {} }, slots: { register: (spec, component) => { rootDefinition=spec;AppFrame = component; return () => {} } } })
    const components = {}
    plugin.apply({ effect: fn => fn(), slots: { inject: (_, fn) => fn(), register: (config, component) => { components[config.id] = component } } })
    const instance=rootDefinition.store().create(),actions=instance.actions;rootDefinition.inject(actions)
    const slots = (name, props) => name === 'workspace.item' ? React.createElement(components['browser-pane'], props)
      : name === 'conversation' ? React.createElement('div', null, 'Conversation', React.createElement(plugin.BrowserToggle)) : null
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    root.render(React.createElement(AppFrame, {
      useStore:selector=>selector(React.useSyncExternalStore(instance.subscribe,instance.getSnapshot)),
      useSessions: selector => selector({ current: undefined, byId: {} }), actions, renderSlot: slots,
    }))
  })
  await page.getByRole('tab', { name: 'example.com' }).waitFor()
  await page.waitForFunction(() => commands.some(call => call.command === 'desktop_browser_navigate'))
  assert.equal(await page.evaluate(() => window.activeTab), 'browser:7', 'an empty viewport-sized shell carrier must not hide its peer')
  if (process.env.UI_TEST_IMPL !== 'legacy') {
    assert.equal(await page.locator('.xhbrowser-header-trigger').getAttribute('aria-expanded'), 'true', 'restored tabs publish their actual visibility to the header')
    await page.getByRole('button', {name:'收起右侧工作区'}).click()
    await page.waitForFunction(()=>window.activeTab===null&&document.querySelector('[data-xhworkspace-open]')===null)
    await page.getByRole('button', {name:'展开右侧工作区'}).click()
    await page.waitForFunction(()=>window.activeTab==='browser:7')
    assert.equal(await page.getByRole('tab').count(),1,'restored tab survives hiding without duplication')
  }
  await page.evaluate(() => {
    const menu = document.createElement('div'); menu.id = 'shell-card'
    menu.style.cssText = 'position:absolute;right:20px;top:150px;width:220px;height:160px;background:white'
    menu.textContent = 'Shell command popup'; document.querySelector('[data-shell-overlay]').append(menu)
  })
  await page.waitForFunction(() => window.activeTab === null)
  await page.setViewportSize({ width: 1240, height: 760 })
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.activeTab), null, 'a resize cannot raise the native peer above shell UI')
  await page.evaluate(() => document.getElementById('shell-card').remove())
  await page.waitForFunction(() => window.activeTab === 'browser:7')
  assert.equal(await page.evaluate(() => commands.filter(call => call.command === 'desktop_browser_navigate').length), 1, 'restoring presentation must not replay navigation')
  const commands = await page.evaluate(() => window.commands)
  assert.equal(commands.find(call => call.command === 'desktop_browser_navigate').args.url, 'https://example.com/')
  assert.ok(commands.some(call => call.command === 'desktop_browser_restore'))
  await page.evaluate(() => root.unmount())
  assert.deepEqual(errors, [])
  console.log(`${engine}: stable native browser snapshot restored into workspace`)
} finally { await browser.close() }
