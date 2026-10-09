import {openAccountSettings} from './fixtures/open-account-settings.mjs'
/** Full shipped graph: section card widths must never resize the native modal/mask. */
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
  const settings=page.getByRole('button',{name:'Account & settings',exact:true})
  await settings.waitFor()

  const evidence = process.env.UI_SETTINGS_MASK_RECEIPT_DIR
  if (evidence) mkdirSync(evidence, {recursive:true})
  const sections = [
    ['General', null, 800],
    ['Models', null, 800],
    ['Profile', '.xhp-root', 1040],
    ['Archived chats', '.xhtask-settings-root', 1180],
    ['Display & shortcuts', '.xhe-root', 800],
  ]
  const dialog = page.getByRole('dialog', {name:'Settings',exact:true})
  const geometry = () => page.evaluate(() => {
    const surface = document.querySelector('dialog:modal')
    const mask = surface.querySelector('._8OspXW_mask')
    // Retain the old selector only for reproducing pre-fix shipped builds.
    const panel = surface.querySelector('[data-xh-settings-panel]') ?? surface.querySelector('._8OspXW_panel')
    const rect = el => {const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}
    const style=getComputedStyle(mask)
    return {viewport:{width:innerWidth,height:innerHeight},dialog:rect(surface),mask:rect(mask),panel:rect(panel),
      paint:{background:style.backgroundColor,blur:style.backdropFilter},
      edgeMasked:document.elementFromPoint(innerWidth-2,innerHeight/2)===mask}
  })
  const near = (actual, expected, message) => assert.ok(Math.abs(actual-expected)<1, `${message}: ${actual} != ${expected}`)
  let cases=0
  for (const theme of ['light','dark']) {
    // Resolve the default System appearance through the real theme presenter.
    // No preference writes: the readiness fixture intentionally rejects saves.
    await page.emulateMedia({colorScheme:theme})
    await page.waitForFunction(want=>document.body.hasAttribute('data-ds-dark-theme')===want, theme==='dark')
    await openAccountSettings(page); await dialog.waitFor()
    await dialog.getByRole('button',{name:'General',exact:true}).click()
    const expectedPaint=(await geometry()).paint
    for (const width of [1810,1280,960,640,426]) {
      const height=width<=640 ? 664 : 900
      await page.setViewportSize({width,height})
      for (const [name, content, idealWidth] of sections) {
        await dialog.getByRole('button',{name,exact:true}).click()
        if(content) await dialog.locator(content).waitFor()
        // Wait for the native top-layer and React section commit, not arbitrary sleeps.
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())))
        const g=await geometry()
        for (const part of ['dialog','mask']) {
          near(g[part].x,0, `${theme}/${width}/${name} ${part} starts at the left edge`)
          near(g[part].y,0, `${theme}/${width}/${name} ${part} starts at the top edge`)
          near(g[part].width,width, `${theme}/${width}/${name} ${part} covers viewport width`)
          near(g[part].height,height, `${theme}/${width}/${name} ${part} covers viewport height`)
        }
        near(g.panel.x+g.panel.width/2,width/2, `${theme}/${width}/${name} card remains horizontally centered`)
        near(g.panel.y+g.panel.height/2,height/2, `${theme}/${width}/${name} card remains vertically centered`)
        assert.ok(g.panel.width<=width-24+1 && g.panel.height<=height-24+1, `${name} card retains viewport gutters`)
        if(width>=1280) near(g.panel.width,idealWidth,`${name} changes only the content card width`)
        assert.deepEqual(g.paint,expectedPaint, `${name} shares theme mask color and blur`)
        assert.equal(g.edgeMasked,true, `${name} right-edge pointer target is the mask`)
        cases++
        if(evidence && width===1810 && ['Profile','Archived chats'].includes(name)) {
          await page.screenshot({path:resolve(evidence,`${engine}-${theme}-${name.replaceAll(' ','-')}.png`)})
        }
        // Exercise the formerly exposed strip in every section, not only General.
        await page.mouse.click(width-2,height/2)
        await dialog.waitFor({state:'hidden'})
        await openAccountSettings(page); await dialog.waitFor()
      }
    }
    await dialog.getByRole('button',{name:'Close',exact:true}).click()
    await dialog.waitFor({state:'hidden'})
  }
  assert.deepEqual(errors, [], 'no browser runtime errors')
  console.log(`${engine}: ${cases} settings mask/card cases passed; right-edge close and reopen passed`)
} finally { await browser.close() }
