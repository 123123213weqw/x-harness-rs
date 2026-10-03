/** Page priority regressions run the owned graph with isolated fixture transport. */
import assert from 'node:assert/strict'
import {readFileSync, existsSync, mkdirSync} from 'node:fs'
import {resolve, sep, extname} from 'node:path'
import {createRequire} from 'node:module'

const engine=process.env.UI_TEST_BROWSER??'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const base=resolve('ui/dist')
const deps=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const require=createRequire(resolve(deps,'package.json'))
const browser=await require('playwright')[engine].launch({headless:true})
try {
  const page=await browser.newPage({viewport:{width:1280,height:820},locale:'en-US',colorScheme:'light'})
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/*',route=>{
    const url=new URL(route.request().url())
    if(url.hostname!=='127.0.0.1')return route.abort('blockedbyclient')
    const local=resolve(base,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname))
    if(!local.startsWith(base+sep)||!existsSync(local))return route.fulfill({status:404,body:'fixture asset missing'})
    const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm'}
    return route.fulfill({body:readFileSync(local),contentType:types[extname(local)]??'application/octet-stream'})
  })
  await page.goto('http://127.0.0.1:39187/?fixture=1')
  const settings=page.getByRole('button',{name:'Settings',exact:true})
  const dialog=page.getByRole('dialog',{name:'Settings',exact:true})
  await settings.click()
  await dialog.waitFor()
  const language=dialog.getByRole('button',{name:'English',exact:true})
  await language.click()
  assert.equal(await dialog.getByRole('menu').count(),1,'portal menu must be inside its native modal')
  await language.press('Escape')
  assert.equal(await page.getByRole('menu').count(),0)
  assert.equal(await dialog.isVisible(),true,'first Escape dismisses only the child menu')
  await language.click()
  await dialog.getByRole('menuitem',{name:'English',exact:true}).click()
  assert.equal(await dialog.isVisible(),true,'portaled option remains pointer-interactive in the top layer')

  await dialog.getByRole('button',{name:'Queue',exact:true}).press('Tab')
  for(let i=0;i<18;i++) {
    assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('dialog:modal')),true,'Tab never reaches background controls')
    await page.keyboard.press('Tab')
  }
  await dialog.getByRole('button',{name:'General',exact:true}).press('Shift+Tab')
  assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('dialog:modal')),true,'reverse Tab also stays modal')
  await page.keyboard.press('Escape')
  await dialog.waitFor({state:'hidden'})
  assert.equal(await settings.evaluate(el=>el===document.activeElement),true,'close restores the opening trigger')

  await settings.click()
  await page.setViewportSize({width:426,height:664})
  await page.locator('[data-sidebar-collapsed]').waitFor()
  await page.waitForFunction(()=>{
    const rail=document.querySelector('[data-sidebar-collapsed] ._84hhiq_sidebarCol')
    return rail && Math.abs(rail.getBoundingClientRect().width-56)<1
  })
  const geometry=await dialog.evaluate(el=>{
    const panel=el.querySelector('nav')?.parentElement
    const options=el.querySelector('nav')?.nextElementSibling?.lastElementChild
    return {width:panel?.getBoundingClientRect().width,navWidth:el.querySelector('nav')?.getBoundingClientRect().width,optionWidth:options?.getBoundingClientRect().width}
  })
  assert.ok(geometry.navWidth>=geometry.width-2,'narrow settings navigation moves above the form')
  assert.ok(geometry.optionWidth>240,'form controls retain a usable content width')
  if(process.env.UI_PRIORITY_RECEIPT_DIR){
    mkdirSync(process.env.UI_PRIORITY_RECEIPT_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.UI_PRIORITY_RECEIPT_DIR,engine+'-narrow-settings.png')})
  }
  await dialog.getByRole('button',{name:'Close',exact:true}).click()
  assert.equal(await settings.isVisible(),true,'collapsed Settings keeps its accessible name')
  // Slot occupants can publish the new concession one commit after the frame.
  // Wait for the actual rail controls too, not only the grid's geometry.
  await page.getByRole('button',{name:'Open sidebar',exact:true}).waitFor()
  await page.waitForFunction(()=>document.querySelectorAll('button[aria-label="New session"]').length===1)
  await page.getByRole('button',{name:'New session',exact:true}).click()
  const composer=page.getByPlaceholder('Describe what you want to build',{exact:true})
  const before=await composer.boundingBox()
  await page.getByRole('button',{name:'Open sidebar',exact:true}).click()
  await page.locator('[data-sidebar-drawer]').waitFor()
  const after=await composer.boundingBox()
  assert.ok(Math.abs(before.width-after.width)<2,'sidebar drawer does not squeeze the composer')
  assert.ok(after.width>240,'composer remains wide enough in the narrow viewport')
  // The scrim sits below the drawer; its unobstructed right edge must work.
  await page.getByRole('button',{name:'Close sidebar',exact:true}).click({position:{x:410,y:30}})
  await page.getByRole('button',{name:'Open sidebar',exact:true}).waitFor()
  await settings.click()
  await dialog.waitFor()
  await dialog.getByRole('button',{name:'Close',exact:true}).click()
  // Exercise the actual platform Modal/Menu exports without Host fixtures
  // inventing removable provider records or executing a destructive action.
  const primitive=await browser.newPage({viewport:{width:960,height:720}})
  const html=readFileSync(resolve(base,'index.html'),'utf8')
  const entry=html.match(/src="(\/assets\/platform-[^"?]+\.js)"/)[1]
  const css=[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(row=>row[1])
  await primitive.route('**/*',route=>{
    const url=new URL(route.request().url())
    if(url.hostname!=='127.0.0.1')return route.abort('blockedbyclient')
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head>${css.map(path=>`<link rel="stylesheet" href="${path}">`).join('')}<script>window.__ModuleLoader__={create:options=>{window.staticModules=options.staticModules;throw Error('isolated primitive boot stopped')}};</script><script type="module" src="${entry}"></script></head><body><div id="root"></div></body></html>`})
    const file=resolve(base,'.'+decodeURIComponent(url.pathname))
    if(!file.startsWith(base+sep)||!existsSync(file))return route.fulfill({status:404,body:''})
    return route.fulfill({body:readFileSync(file),contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript'})
  })
  await primitive.goto('http://127.0.0.1:39187/')
  await primitive.waitForFunction(()=>window.staticModules)
  await primitive.evaluate(()=>{
    const R=staticModules.react,D=staticModules['react-dom/client'],P=staticModules['@xharness/dsh-client-ui-primitives']
    window.primitiveChoices=[]
    function Fixture(){
      const [outer,setOuter]=R.useState(true),[inner,setInner]=R.useState(false),[menu,setMenu]=R.useState(false)
      const dropdown=R.createElement(P.Menu,{open:menu,portal:true,
        anchor:R.createElement(P.Button,{onClick:()=>setMenu(true)},'Inner menu'),
        items:[{id:'alpha',label:'Alpha'}],onSelect:id=>{primitiveChoices.push(id);setMenu(false)},onClose:()=>setMenu(false)})
      const nested=R.createElement(P.Modal,{open:inner,title:'Inner',onClose:()=>setInner(false)},dropdown)
      return R.createElement(P.Modal,{open:outer,title:'Outer',onClose:()=>setOuter(false)},
        R.createElement(P.Button,{onClick:()=>setInner(true)},'Open inner'),nested)
    }
    D.createRoot(document.getElementById('root')).render(R.createElement(Fixture))
  })
  await primitive.getByRole('button',{name:'Open inner',exact:true}).click()
  assert.equal(await primitive.locator('dialog:modal').count(),2)
  const inner=primitive.getByRole('dialog',{name:'Inner',exact:true})
  await inner.getByRole('button',{name:'Inner menu',exact:true}).click()
  assert.equal(await inner.getByRole('menu').count(),1)
  await primitive.keyboard.press('Escape')
  assert.equal(await inner.isVisible(),true)
  assert.equal(await inner.getByRole('menu').count(),0)
  await inner.getByRole('button',{name:'Inner menu',exact:true}).click()
  await inner.getByRole('menuitem',{name:'Alpha',exact:true}).click()
  assert.deepEqual(await primitive.evaluate(()=>primitiveChoices),['alpha'])
  await primitive.keyboard.press('Escape')
  assert.equal(await primitive.locator('dialog:modal').count(),1,'only inner modal closes')
  assert.equal(await primitive.getByRole('dialog',{name:'Outer',exact:true}).isVisible(),true)
  assert.equal(await primitive.getByRole('button',{name:'Open inner',exact:true}).evaluate(el=>el===document.activeElement),true)
  assert.deepEqual(errors,[],'no script exceptions during page lifecycle transitions')
  console.log(JSON.stringify({engine,nestedEscape:true,modalFocus:true,focusRestored:true,nativeMenuInteractive:true,nestedModal:true,narrowSettings:true,sidebarDrawer:true,collapsedSettingsName:true,errors}))
} finally { await browser.close() }
