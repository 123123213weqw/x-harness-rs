import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
// Isolated regression of the shipped AppFrame browser dock, no Rust Host required.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const layoutSource=ownedViewModuleTestInput('@xharness/dsh-client-ui-layout')
  const page = await browser.newPage({ viewport: { width: 1280, height: 780 } })
  const errors = []
  page.on('pageerror', error => {if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  // Host boot is intercepted before theme activation. The platform's global
  // keyboard-focus rule needs the same primary-label token as the real shell.
  await installOwnedViewHtml(page,process.env.UI_TEST_IMPL??'canonical','<html><head></head><body style="margin:0;--dsw-alias-label-primary:#0f1115"><div id="root" style="position:fixed;inset:0"></div></body></html>')
  await page.addScriptTag({ content: 'window.__ModuleLoader__={load:x=>{window.registrations??={};registrations[x.id]=x}}' })
  await page.addScriptTag({ content: layoutSource })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xlang/xharness-client-ui-browser') })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xharness/dsh-client-runtime') })
  if (process.env.UI_TEST_IMPL !== 'legacy') await page.addScriptTag({content:ownedViewModuleTestInput('@xharness/dsh-session-log-export')})
  await page.evaluate(includeSessionLog => {
    const engine=registrations['@xharness/dsh-client-runtime'].factory(id=>{if(id in staticModules)return staticModules[id];throw Error(id)})
    const runtime=id=>{if(id==='@xharness/dsh-client-runtime/client')return engine;if(id in staticModules)return staticModules[id];throw Error(id)}
    const layout = registrations['@xharness/dsh-client-ui-layout'].factory(runtime)
    const browser = registrations['@xlang/xharness-client-ui-browser'].factory(runtime)
    browser.apply({ effect: fn => fn(), slots: { inject: (_, fn) => fn(), register: () => {} } })
    let SessionLogHeader
    if (includeSessionLog) {
      const sessionLog = registrations['@xharness/dsh-session-log-export'].factory(runtime)
      sessionLog.apply({provide:()=>{},effect:fn=>fn(),on:()=>{},locale:{register:()=>()=>{}},
        slots:{inject:(_,fn)=>fn(),register:(_,component)=>{SessionLogHeader=component}}})
    }
    let AppFrame,rootDefinition
    layout.apply({
      effect: (fn, label) => { if (label.includes('service')) fn() },
      reflect: { provide: (_name, service) => { window.layoutService = service; return () => {} } },
      slots: { register: (spec, component) => { rootDefinition=spec;AppFrame = component; return () => {} } },
    })
    const instance=rootDefinition.store().create(),actions=instance.actions;rootDefinition.inject(actions)
    window.layoutActions = actions
    const slots = (name, props) => {
      if (name === 'shell.overlay') return null
      if (name === 'workspace.item') return React.createElement(browser.BrowserPane, props)
      if (name === 'conversation') return React.createElement('div', { style: { position: 'absolute', top: 8, right: 8, display:'flex', alignItems:'center', gap:8 } },
        SessionLogHeader?React.createElement(SessionLogHeader,{sessionId:'toolbar-test',useSessionLogDownload:select=>select({bySession:{}}),request:async()=>{},dismiss:()=>{},t:key=>key}):null,
        React.createElement(browser.BrowserToggle))
      return React.createElement('div', null, name)
    }
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    function App() {
      const [current,setCurrent]=React.useState(undefined);window.setCurrentSession=setCurrent
      const [headerVisible,setHeaderVisible]=React.useState(true);window.setHeaderVisible=setHeaderVisible
      return React.createElement(AppFrame, {
        useStore:selector=>selector(React.useSyncExternalStore(instance.subscribe,instance.getSnapshot)),
        useSessions: selector => selector({ current, byId: current?{[current]:{blank:false}}:{} }), actions,
        renderSlot:(name,props)=>name==='conversation'&&!headerVisible?null:slots(name,props),
      })
    }
    root.render(React.createElement(App))
  },process.env.UI_TEST_IMPL !== 'legacy')
  const centerBefore = await page.locator('._84hhiq_centerCol').evaluate(element => element.getBoundingClientRect().width)
  await page.getByRole('button', { name: '展开右侧工作区' }).click()
  await page.getByRole('region', { name: '工作区' }).waitFor()
  if (process.env.UI_TEST_IMPL !== 'legacy') assert.equal(await page.getByRole('tab', { name: '新标签页', exact: true }).locator('.xhworkspace-kind').count(), 0, 'new browser tabs have no leading icon or icon spacer')
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
  await page.evaluate(()=>document.fonts.ready);const initialPixelsSha256=createHash('sha256').update(await page.locator('#root').screenshot({animations:'disabled'})).digest('hex')
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
  if (process.env.UI_TEST_IMPL !== 'legacy') {
    const trigger = page.locator('.xhbrowser-header-trigger')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'header trigger reports the actual open dock')
    const toolbarGeometry = await page.evaluate(() => {
      const toggle=document.querySelector('.xhbrowser-header-trigger'),log=[...document.querySelectorAll('button')].find(element=>element.textContent==='Session log')
      const box=element=>{const r=element.getBoundingClientRect();return{width:r.width,height:r.height,centerY:r.y+r.height/2}}
      return{toggle:box(toggle),log:box(log),toggleIcon:box(toggle.querySelector('svg')),logIcon:box(log.querySelector('svg')),
        duration:getComputedStyle(toggle.querySelector('.xhbrowser-dock-chevron')).transitionDuration,
        animation:getComputedStyle(toggle.querySelector('.xhbrowser-dock-chevron')).animationName}
    })
    assert.equal(toolbarGeometry.toggle.width,32);assert.equal(toolbarGeometry.toggle.height,32)
    assert.equal(toolbarGeometry.log.height,32,'the toggle shares the actual Session log capsule height')
    assert.equal(toolbarGeometry.toggle.centerY,toolbarGeometry.log.centerY,'toolbar controls share a vertical center')
    assert.equal(toolbarGeometry.toggleIcon.width,16);assert.equal(toolbarGeometry.toggleIcon.height,16)
    assert.equal(toolbarGeometry.logIcon.width,16);assert.equal(toolbarGeometry.logIcon.height,16,'neighboring icons use the same enlarged size')
    assert.equal(toolbarGeometry.duration,'0.18s','a short state transition, not a perpetual spinner')
    assert.equal(toolbarGeometry.animation,'none')
    await page.waitForFunction(()=>new DOMMatrix(getComputedStyle(document.querySelector('.xhbrowser-dock-chevron')).transform).a<-.999)
    await page.emulateMedia({reducedMotion:'reduce'})
    assert.equal(await trigger.locator('.xhbrowser-dock-chevron').evaluate(element=>getComputedStyle(element).transitionDuration),'0s','reduced motion disables the arrow transition')
    assert.equal(await trigger.locator('.xhbrowser-dock-panel').evaluate(element=>getComputedStyle(element).transitionDuration),'0s','reduced motion also disables the panel tint transition')
    // Enter on a mouse-focused button does not establish :focus-visible in
    // every engine. Reach it by real keyboard navigation from its neighbor.
    await page.getByRole('button',{name:'Session log',exact:true}).press('Tab')
    assert.equal(await trigger.evaluate(element=>element===document.activeElement),true,'Tab reaches the workspace control after Session log')
    await trigger.press('Enter')
    await page.getByRole('region',{name:'工作区',exact:true}).waitFor({state:'hidden'})
    await page.getByRole('button',{name:'展开右侧工作区',exact:true}).waitFor()
    await page.waitForFunction(()=>new DOMMatrix(getComputedStyle(document.querySelector('.xhbrowser-dock-chevron')).transform).a>.999)
    assert.equal(await trigger.locator('.xhbrowser-dock-chevron').evaluate(element=>new DOMMatrix(getComputedStyle(element).transform).a),1,'closed chevron points left, toward expansion')
    assert.equal(await trigger.evaluate(element=>getComputedStyle(element).outlineStyle),'solid','keyboard focus remains visible')
    await trigger.press('Space')
    await page.getByRole('region',{name:'工作区',exact:true}).waitFor()
    await page.getByRole('button',{name:'收起右侧工作区',exact:true}).waitFor()
    await page.waitForFunction(()=>new DOMMatrix(getComputedStyle(document.querySelector('.xhbrowser-dock-chevron')).transform).a<-.999)
    assert.equal(await trigger.locator('.xhbrowser-dock-chevron').evaluate(element=>new DOMMatrix(getComputedStyle(element).transform).a),-1,'open chevron points right, toward collapse')
    await page.emulateMedia({reducedMotion:'no-preference'})
    await page.evaluate(()=>setHeaderVisible(false));await trigger.waitFor({state:'detached'})
    await page.evaluate(()=>setHeaderVisible(true));await trigger.waitFor()
    await page.getByRole('button',{name:'收起右侧工作区',exact:true}).waitFor()
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'a remounted header requests the owner\'s current visibility')
    const residentPane = await page.locator('.xhworkspace-item').elementHandle()
    await page.getByRole('textbox', { name: '网址' }).fill('unfinished-address.test')
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.getByRole('button', { name: '收起右侧工作区' }).click()
      await page.waitForFunction(() => document.querySelector('._84hhiq_frame').hasAttribute('data-details-collapsed'))
      // The owner commits first, then publishes visibility to the header.
      // Wait for that projection rather than racing the passive effect.
      await page.getByRole('button',{name:'展开右侧工作区',exact:true}).waitFor()
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
      assert.equal(await page.getByRole('region', { name: '工作区', exact: true }).isVisible(), false)
      assert.equal(await page.locator('[role="tab"]').count(), 1, 'collapse retains the tab rather than closing it')
      await page.getByRole('button', { name: '展开右侧工作区' }).click()
      await page.getByRole('tab', { name: 'example.com', exact: true }).waitFor()
      assert.equal(await residentPane.evaluate(element => element.isConnected), true, 'collapse does not unmount the active pane')
      assert.equal(await page.getByRole('textbox', { name: '网址' }).inputValue(), 'unfinished-address.test', 'collapse/reopen preserves the unsubmitted address draft')
      assert.equal(await page.locator('[role="tab"]').count(), 1, 'reopening must not add a browser tab')
    }
    await page.getByRole('textbox', { name: '网址' }).fill('https://example.com/')
  }
  await page.evaluate(() => { layoutService.attachPanels(layoutActions); layoutService.openDetails() })
  await page.getByRole('tab', { name: '工具详情' }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 2, 'tool details and browser share one tab strip')
  if (process.env.UI_TEST_IMPL !== 'legacy') {
    await page.getByRole('button', { name: '收起右侧工作区' }).click()
    await page.getByRole('region', { name: '工作区', exact: true }).waitFor({state:'hidden'})
    await page.getByRole('button', { name: '展开右侧工作区' }).click()
    await page.getByRole('tab', { name: '工具详情', exact: true }).waitFor()
    assert.equal(await page.getByRole('tab', { name: '工具详情', exact: true }).getAttribute('aria-selected'), 'true', 'reopening retains the selected tool, not a different browser')
    assert.equal(await page.getByRole('tab').count(), 2)
  }
  if (process.env.UI_TEST_IMPL !== 'legacy') {
    assert.equal(await page.getByRole('tab', { name: 'example.com', exact: true }).locator('.xhworkspace-kind').count(), 0, 'navigating does not restore the browser icon')
    assert.equal(await page.getByRole('tab', { name: '工具详情', exact: true }).locator('.xhworkspace-kind').count(), 1, 'tool tab identification is unchanged')
  }
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
  if (process.env.UI_TEST_IMPL !== 'legacy') {
    await page.getByRole('button', { name: '收起右侧工作区' }).click()
    await page.getByRole('region', { name: '工作区', exact: true }).waitFor({state:'hidden'})
    await page.evaluate(()=>setCurrentSession('other-session'))
    await page.getByRole('button', { name: '展开右侧工作区' }).click()
    await page.getByRole('tab', { name: '新标签页', exact: true }).waitFor()
    await page.evaluate(()=>setCurrentSession(undefined))
    await page.getByRole('region', { name: '工作区', exact: true }).waitFor({state:'hidden'})
    await page.getByRole('button',{name:'展开右侧工作区',exact:true}).waitFor()
    assert.equal(await page.locator('.xhbrowser-header-trigger').getAttribute('aria-expanded'), 'false', 'switching back preserves that session\'s collapsed state')
    await page.getByRole('button', { name: '展开右侧工作区' }).click()
    await page.getByRole('tab', { name: 'example.com', exact: true }).waitFor()
  }
  await page.setViewportSize({ width: 700, height: 780 })
  await page.waitForFunction(() => document.querySelector('[data-xhworkspace-drawer]') !== null)
  await page.waitForFunction(() => {
    const panel = document.querySelector('._84hhiq_detailsCol').getBoundingClientRect()
    return Math.abs(panel.right - 700) < 1 && Math.abs(panel.width - 560) < 1
  })
  assert.equal(await page.getByRole('button', { name: '更多浏览器操作', exact: true }).evaluate(element => {
    const box = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  }), true, 'narrow drawer controls are inside the viewport and above the workspace scrim')
  assert.equal(await page.getByRole('button', { name: '关闭工作区' }).count(), 1, 'drawer adds a dismissible scrim')
  await assertShellAboveBrowser()
  await page.getByRole('button', { name: '关闭工作区' }).click({ position: { x: 20, y: 20 } })
  await page.getByRole('region', { name: '工作区' }).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '展开右侧工作区' }).click()
  assert.equal(await page.getByRole('textbox', { name: '网址' }).inputValue(), process.env.UI_TEST_IMPL==='legacy'?'':'https://example.com/', 'drawer dismissal preserves navigation; explicit tab close still discards it')
  if (process.env.UI_TEST_IMPL !== 'legacy') {
    await page.setViewportSize({width:1280,height:780})
    await page.getByRole('button', {name:'关闭 example.com'}).click()
    await page.getByRole('region', {name:'工作区',exact:true}).waitFor({state:'hidden'})
    await page.evaluate(()=>layoutService.openDetails())
    await page.getByRole('tab', {name:'工具详情',exact:true}).waitFor()
    await page.getByRole('button', {name:'收起右侧工作区'}).click()
    await page.getByRole('region', {name:'工作区',exact:true}).waitFor({state:'hidden'})
    await page.getByRole('button', {name:'展开右侧工作区'}).click()
    assert.equal(await page.getByRole('tab', {name:'工具详情',exact:true}).getAttribute('aria-selected'),'true')
    assert.equal(await page.getByRole('tab').count(),1,'tool-only reopening does not invent a browser tab')
    await page.getByRole('button', {name:'收起右侧工作区'}).click()
    await page.getByRole('region', {name:'工作区',exact:true}).waitFor({state:'hidden'})
    await page.evaluate(()=>layoutService.openDetails())
    await page.getByRole('region', {name:'工作区',exact:true}).waitFor()
    assert.equal(await page.getByRole('tab').count(),1,'an explicit tool-open reveals the existing hidden tool')
    await page.evaluate(()=>layoutService.closeDetails())
    await page.waitForFunction(()=>document.querySelector('.xhbrowser-header-trigger')?.getAttribute('aria-expanded')==='false')
  }
  await page.evaluate(() => root.unmount())
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({engine,implementation:process.env.UI_TEST_IMPL??'canonical',actualPlatform:true,actualRuntimeEngine:true,initialPixelsSha256,pageErrors:errors}))
  console.log(`${engine}: browser layout fallback passed`)
} finally { await browser.close() }
