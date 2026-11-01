import {fixtureUiRoot} from './fixtures/ui-fixture-build.mjs'
// Exercise shipped sidebar row navigation and its nested actions. Transport is
// isolated in-process fixture data; no real Host or model is contacted.
import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
import {createRequire} from 'node:module'

const engine=process.env.UI_TEST_BROWSER??'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const base=fixtureUiRoot()
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const browser=await require('playwright')[engine].launch({headless:true})
try {
  const page=await browser.newPage({viewport:{width:1280,height:820},locale:'en-US'})
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  const routeUi=route=>{
    const url=new URL(route.request().url())
    if(url.hostname!=='127.0.0.1')return route.abort('blockedbyclient')
    const local=resolve(base,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname))
    if(!local.startsWith(base+sep)||!existsSync(local))return route.fulfill({status:404,body:'fixture asset missing'})
    const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm'}
    return route.fulfill({body:readFileSync(local),contentType:types[extname(local)]??'application/octet-stream'})
  }
  await page.route('**/*',routeUi)
  await page.goto('http://127.0.0.1:39187/?fixture=1')
  await page.getByRole('button',{name:'Account & settings',exact:true}).waitFor()
  const touch=await browser.newPage({viewport:{width:320,height:780},locale:'en-US',hasTouch:true})
  touch.on('pageerror',error=>errors.push(error.message));await touch.route('**/*',routeUi)
  await touch.goto('http://127.0.0.1:39187/?fixture=1')
  await touch.getByRole('button',{name:'Account & settings',exact:true}).waitFor()
  assert.equal(await touch.evaluate(()=>matchMedia('(pointer:coarse)').matches),true)
  for(const width of [320,375,426,600]) {
    await touch.setViewportSize({width,height:780})
    await touch.waitForFunction(()=>getComputedStyle(document.querySelector('._84hhiq_frame')).getPropertyValue('--xh-region-inset').trim()==='0px')
    const metrics=await touch.locator('._84hhiq_centerCol>._84hhiq_regionSurface').evaluate(element=>({border:getComputedStyle(element).borderTopWidth,radius:getComputedStyle(element).borderTopLeftRadius,top:element.getBoundingClientRect().top}))
    assert.equal(metrics.border,'0px');assert.equal(metrics.radius,'0px');assert.equal(metrics.top,0)
    const create=touch.locator('button.U910La_newSession:visible')
    await create.waitFor();const bounds=await create.boundingBox();assert.ok(bounds.width>=44&&bounds.height>=44,JSON.stringify({width,bounds}))
    assert.equal(await touch.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  }
  await touch.close()
  await page.setViewportSize({width:426,height:664})
  const opener=page.getByRole('button',{name:'Open sidebar',exact:true})
  await opener.waitFor()
  await page.waitForFunction(()=>document.querySelectorAll('button[aria-label="New session"]').length===1)
  await opener.click()
  const drawer=page.locator('[data-sidebar-drawer]')
  await drawer.waitFor()
  const row=page.locator('[role="treeitem"][aria-selected]:has(button[aria-label^="Session actions for"])').first()
  await row.hover()
  const actions=row.getByRole('button',{name:/^Session actions for/})
  await actions.click()
  assert.equal(await drawer.count(),1,'row actions must leave the sidebar drawer mounted')
  const menu=page.getByRole('menu')
  await menu.waitFor()
  for(const name of ['Rename','Fork session','Archive session']) {
    assert.equal(await menu.getByRole('menuitem',{name,exact:true}).isVisible(),true)
  }
  await actions.press('Escape')
  await menu.waitFor({state:'hidden'})
  assert.equal(await drawer.count(),1,'Escape closes only the row menu')
  assert.equal(await actions.evaluate(element=>element===document.activeElement),true,'menu close restores its trigger')
  await actions.press('Enter')
  await menu.waitFor()
  await menu.getByRole('menuitem',{name:'Rename',exact:true}).click()
  const rename=page.getByRole('dialog',{name:'Rename session',exact:true})
  await rename.waitFor()
  assert.equal(await drawer.count(),1,'a portaled row action must not navigate or close the drawer')
  await rename.getByRole('button',{name:'Cancel',exact:true}).click()
  await rename.waitFor({state:'hidden'})
  assert.equal(await drawer.count(),1)
  await row.locator('.PT4Uyq_title').click()
  await drawer.waitFor({state:'hidden'})
  await opener.waitFor()
  // The ordinary wide layout must keep the same row actions usable.
  await page.setViewportSize({width:1280,height:820})
  await page.waitForFunction(()=>document.querySelector('[data-sidebar-collapsed]')===null)
  await row.hover()
  await actions.click()
  await menu.waitFor()
  assert.equal(await menu.getByRole('menuitem',{name:'Rename',exact:true}).isVisible(),true)
  await actions.press('Escape')
  await menu.waitFor({state:'hidden'})
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({engine,narrowRowActions:true,keyboardMenu:true,renameDialog:true,navigationClosesDrawer:true,wideRowActions:true,errors}))
} finally {await browser.close()}
