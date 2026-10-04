/** Real shared surface and local document, Chromium/WebKit, no live Host. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {scriptAsset} from './fixtures/script-asset-test.mjs'

const engine=process.env.UI_TEST_BROWSER??'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const require=createRequire(resolve('ui/package.json'))
const deps=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const bundle=require('esbuild').buildSync({entryPoints:['ui/src/modules/platform/web/boot-page.ts'],bundle:true,write:false,
  format:'iife',globalName:'BootFixture',platform:'browser',target:'es2022',outfile:'startup-fixture.js',loader:{'.raw.css':'text','.svg':'text','.module.css':'local-css'}})
const code=bundle.outputFiles.find(file=>!file.path.endsWith('.css'))?.text
assert.ok(code)
const desktop=readFileSync('apps/desktop/frontend/index.html','utf8')
const style=readFileSync('ui/src/startup/surface.raw.css','utf8')
const titlebar=readFileSync('ui/desktop/titlebar.css','utf8')
const phase2=`<!doctype html><html><head><style id="xh-startup-style">${style}</style><style>html,body,#root{height:100%;margin:0}[data-dsh-boot]{height:100%}${titlebar}</style></head><body><div id="root"></div><script>${scriptAsset('desktop-titlebar.js')}</script><script>${code}</script><script>window.boot=new BootFixture.BootPage(document.getElementById('root'))</script></body></html>`
const browser=await deps('playwright')[engine].launch({headless:true})
let cases=0
try {
  async function pageFor({native=false,kind='web',reduced=false,dark=false,pause=false,statusError=null,deferDecode=false}={}) {
    const page=await browser.newPage({viewport:{width:736,height:480},colorScheme:dark?'dark':'light',reducedMotion:reduced?'reduce':'no-preference'})
    const errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.addInitScript(({native,pause,statusError,deferDecode})=>{
      window.motionCalls=[];const animate=Element.prototype.animate
      Element.prototype.animate=function(frames,options){window.motionCalls.push({frames,options});const a=animate.call(this,frames,options);if(pause)a.pause();return a}
      if(deferDecode)HTMLImageElement.prototype.decode=function(){return new Promise(resolve=>{window.resolveMarkDecode=resolve})}
      if(native)window.__TAURI__={core:{invoke:async()=>({startupError:statusError})},event:{listen:async(_name,callback)=>{window.nativeEvent=callback;return()=>{window.unsubscribed=true}}}}
    },{native,pause,statusError,deferDecode})
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:kind==='desktop'?desktop:phase2}))
    await page.goto('http://127.0.0.1:39191/')
    await page.locator('[data-xh-startup]').waitFor()
    return{page,errors}
  }
  const first=await pageFor({native:true,kind:'desktop',pause:true})
  await first.page.waitForFunction(()=>window.motionCalls.length===2)
  assert.equal(await first.page.locator('h1').innerText(),'XHarness')
  await first.page.evaluate(()=>{document.getAnimations().forEach(a=>a.finish());window.nativeEvent({payload:{phase:'starting',message:'正在恢复历史会话…'}})})
  await first.page.waitForFunction(()=>document.getAnimations().length===0)
  assert.equal(await first.page.locator('[role=status]').innerText(),'正在恢复历史会话…');cases++
  const geometry=page=>page.evaluate(()=>{
    const mark=document.querySelector('.xh-startup-mark').getBoundingClientRect(),name=document.querySelector('h1').getBoundingClientRect()
    return{mark:[mark.x,mark.y,mark.width,mark.height],name:[name.x,name.y],bg:getComputedStyle(document.querySelector('[data-xh-startup]')).backgroundColor}
  })
  const second=await pageFor({native:true})
  assert.equal(await second.page.evaluate(()=>window.motionCalls.length),0,'desktop phase two never replays the entrance')
  assert.deepEqual(await geometry(first.page),await geometry(second.page),'both documents have identical resting geometry and palette');cases++
  assert.equal(await second.page.locator('[data-dsh-boot-spinner]').count(),0)
  assert.ok(!/HARNESS\s*Loading plugins/.test(await second.page.locator('body').innerText()));cases++
  await second.page.evaluate(()=>{window.boot.setTotal(3);window.boot.setState('one','active');window.boot.setState('two','loading')})
  assert.equal(await second.page.locator('[data-xh-startup]').getAttribute('data-loaded'),'1')
  assert.equal(await second.page.locator('[data-xh-startup]').getAttribute('data-total'),'3')
  assert.equal(await second.page.locator('[role=status]').innerText(),'正在加载界面…');cases++
  const fast=await pageFor({pause:true})
  await fast.page.waitForFunction(()=>window.motionCalls.length===2)
  await fast.page.evaluate(()=>{window.boot.finish();window.boot.dispose();document.getElementById('root').textContent='ready'})
  assert.equal(await fast.page.locator('[data-xh-startup]').count(),0)
  assert.equal(await fast.page.evaluate(()=>document.getAnimations().length),0);cases++
  const slow=await pageFor()
  await slow.page.waitForFunction(()=>window.motionCalls.length===2&&document.getAnimations().length===0)
  assert.equal(await slow.page.locator('[role=status]').innerText(),'正在加载界面…')
  assert.equal(await slow.page.evaluate(()=>window.motionCalls.length),2,'completed entrance never loops');cases++
  await slow.page.evaluate(()=>window.boot.fail('<img src=x onerror=alert(1)>'))
  assert.equal(await slow.page.locator('[role=status]').innerText(),'Failed to load plugins')
  assert.equal(await slow.page.locator('[role=alert]').innerText(),'<img src=x onerror=alert(1)>')
  assert.equal(await slow.page.locator('img').count(),1,'failure details are text, not HTML');cases++
  const reduced=await pageFor({reduced:true,pause:true})
  await reduced.page.waitForFunction(()=>window.motionCalls.length===2)
  assert.ok(await reduced.page.evaluate(()=>window.motionCalls.every(call=>call.options.duration===120&&!call.frames.some(frame=>'transform'in frame))));cases++
  const reducedPending=await pageFor({reduced:true,deferDecode:true})
  assert.equal(await reducedPending.page.locator('.xh-startup-mark').evaluate(mark=>mark.getBoundingClientRect().width),94,'reduced-motion never paints a giant pending mark')
  await reducedPending.page.evaluate(()=>window.boot.dispose());await reducedPending.page.close();cases++
  const fail=await pageFor({native:true,kind:'desktop',statusError:'previous failure'})
  assert.equal(await fail.page.locator('[role=status]').innerText(),'previous failure')
  assert.equal(await fail.page.evaluate(()=>document.getAnimations().length),0);cases++
  const failureEarly=await pageFor({pause:true})
  await failureEarly.page.waitForFunction(()=>window.motionCalls.length===2)
  await failureEarly.page.evaluate(()=>{window.boot.setState('plugin','failed');window.boot.setState('other','active')})
  assert.equal(await failureEarly.page.locator('[role=status]').innerText(),'Failed to load plugins')
  assert.equal(await failureEarly.page.evaluate(()=>document.getAnimations().length),0);cases++
  await failureEarly.page.evaluate(()=>window.boot.setState('plugin','active'))
  assert.equal(await failureEarly.page.locator('[role=status]').innerText(),'正在加载界面…','transient plugin-fiber recovery preserves the original BootPage behavior')
  assert.equal(await failureEarly.page.evaluate(()=>window.motionCalls.length),2,'recovery does not replay motion')
  await failureEarly.page.evaluate(()=>{window.boot.fail('terminal failure');window.boot.setState('plugin','active')})
  assert.equal(await failureEarly.page.locator('[role=status]').innerText(),'Failed to load plugins','terminal run failure is not cleared by late fiber activation');cases++
  for(const action of ['fail','dispose']) {
    const deferred=await pageFor({deferDecode:true})
    await deferred.page.evaluate(action=>{window.boot[action]('early');window.resolveMarkDecode()},action)
    await deferred.page.evaluate(()=>new Promise(requestAnimationFrame))
    assert.equal(await deferred.page.evaluate(()=>window.motionCalls.length),0,'late image decode cannot animate a failed/disposed surface')
    assert.deepEqual(deferred.errors,[]);await deferred.page.close();cases++
  }
  const exits=[]
  async function prepareExit(options={}) {
    const item=await pageFor({native:true,pause:true,...options})
    exits.push(item)
    await item.page.evaluate(()=>window.boot.prepareHandoff(document.getElementById('root')))
    assert.equal(await item.page.locator('[data-xh-startup-exit]').count(),0,'prepare never covers the app before commit')
    return item
  }
  async function ready(item) {
    await item.page.evaluate(()=>{
      const button=document.createElement('button');button.textContent='Chat action';button.style='position:absolute;top:50%;left:45%';button.onclick=()=>{window.chatClicks=(window.chatClicks??0)+1}
      document.getElementById('root').replaceChildren(button)
      window.boot.completeHandoff()
    })
  }
  const exit=await prepareExit()
  await ready(exit)
  const overlay=exit.page.locator('[data-xh-startup-exit]')
  assert.equal(await overlay.count(),1)
  assert.equal(await overlay.getAttribute('aria-hidden'),'true')
  assert.ok(await overlay.evaluate(el=>el.inert))
  assert.equal(await overlay.evaluate(el=>getComputedStyle(el).pointerEvents),'none')
  assert.ok(await exit.page.evaluate(()=>window.motionCalls.length===3&&window.motionCalls.every(call=>call.options.duration<=180)))
  assert.ok(await exit.page.evaluate(()=>window.motionCalls[0].frames.every(frame=>!frame.transform.includes('translate'))),'exit echoes scale, never flies offscreen')
  await exit.page.getByRole('button',{name:'Chat action'}).click()
  assert.equal(await exit.page.evaluate(()=>window.chatClicks),1,'the UI is immediately clickable under the paused exit');cases++
  await exit.page.evaluate(()=>document.getAnimations().forEach(a=>a.finish()))
  await overlay.waitFor({state:'detached'})
  await exit.page.evaluate(()=>window.boot.completeHandoff())
  assert.equal(await overlay.count(),0)
  assert.equal(await exit.page.evaluate(()=>window.motionCalls.length),3,'commit callback is once-only');cases++
  const finite=await prepareExit({pause:false})
  await ready(finite)
  await finite.page.locator('[data-xh-startup-exit]').waitFor({state:'detached'})
  assert.equal(await finite.page.evaluate(()=>document.getAnimations().length),0,'all exit animations release themselves');cases++
  const staticExit=await prepareExit({reduced:true})
  await ready(staticExit)
  assert.equal(await staticExit.page.evaluate(()=>window.motionCalls.length),0)
  assert.equal(await staticExit.page.locator('[data-xh-startup-exit]').count(),0,'reduced-motion skips the exit completely');cases++
  for(const action of ['fail','dispose']) {
    const stopped=await prepareExit()
    await stopped.page.evaluate(action=>{window.boot[action]('not ready');window.boot.completeHandoff()},action)
    assert.equal(await stopped.page.locator('[data-xh-startup-exit]').count(),0,'failure/disposal never starts a prepared exit')
    assert.equal(await stopped.page.evaluate(()=>window.motionCalls.length),0);cases++
  }
  for(const action of ['hidden','pagehide','resize','dispose','fail']) {
    const cancelled=await prepareExit()
    await ready(cancelled)
    await cancelled.page.evaluate(action=>{
      if(action==='hidden'){Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))}
      else if(action==='pagehide'||action==='resize')window.dispatchEvent(new Event(action))
      else window.boot[action]('cancelled')
      window.boot.completeHandoff()
    },action)
    assert.equal(await cancelled.page.locator('[data-xh-startup-exit]').count(),0,'cancelled exit removes its overlay')
    assert.equal(await cancelled.page.evaluate(()=>document.getAnimations().length),0,'cancelled exit releases every animation');cases++
  }
  const missing=await prepareExit()
  await missing.page.evaluate(()=>{Element.prototype.animate=()=>{throw new Error('animation unavailable')};window.boot.completeHandoff()})
  assert.equal(await missing.page.locator('[data-xh-startup-exit]').count(),0)
  assert.deepEqual(missing.errors,[],'optional animation failure does not fail startup');cases++
  const detached=await prepareExit()
  await detached.page.evaluate(()=>{document.getElementById('root').remove();window.boot.completeHandoff()})
  assert.equal(await detached.page.locator('[data-xh-startup-exit]').count(),0);cases++
  const repeated=await prepareExit()
  await repeated.page.evaluate(()=>window.boot.prepareHandoff(document.getElementById('root')))
  await ready(repeated)
  assert.equal(await repeated.page.locator('[data-xh-startup-exit]').count(),1)
  assert.equal(await repeated.page.evaluate(()=>document.getAnimations().length),3,'re-preparing keeps only one small exit snapshot');cases++
  for(const item of exits){await item.page.evaluate(()=>window.boot.dispose());assert.deepEqual(item.errors,[]);await item.page.close()}
  const darkLocal=await pageFor({native:true,kind:'desktop',dark:true})
  const darkWeb=await pageFor({native:true,dark:true})
  await darkLocal.page.waitForFunction(()=>document.querySelector('[data-xh-startup]').dataset.motion==='idle')
  assert.deepEqual(await geometry(darkLocal.page),await geometry(darkWeb.page))
  assert.notEqual((await geometry(darkWeb.page)).bg,(await geometry(second.page)).bg);cases++
  for(const item of [first,second,fast,slow,reduced,fail,failureEarly,darkLocal,darkWeb]) {
    await item.page.setViewportSize({width:320,height:480})
    assert.ok(await item.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px has no horizontal overflow')
    assert.deepEqual(item.errors,[])
  }
  cases++
  if(process.env.UI_STARTUP_RECEIPT_DIR){mkdirSync(process.env.UI_STARTUP_RECEIPT_DIR,{recursive:true});await darkWeb.page.screenshot({path:resolve(process.env.UI_STARTUP_RECEIPT_DIR,engine+'-startup-dark.png')})}
  console.log(JSON.stringify({engine,cases,sharedGeometry:true,offlineDesktop:true,oneEntrance:true,realFailure:true,fastHandoff:true,reducedMotion:true,centeredExit:true,clickThrough:true,exitCleanup:true,errors:0}))
} finally {await browser.close()}
