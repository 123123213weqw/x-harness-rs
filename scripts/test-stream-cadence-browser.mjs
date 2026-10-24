// Run against scripts/preview-stream-cadence.mjs; never drives the user's app.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
const dependencies=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const require=createRequire(resolve(dependencies,'package.json'))
const {chromium,webkit}=require('playwright')
const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await ({chromium,webkit})[engine].launch({headless:true})
const reports=[]
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'no-preference'})
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(process.env.STREAM_DEMO_URL??'http://127.0.0.1:3270/')
 const before=page.locator('[data-side=before] .body'),after=page.locator('[data-side=after] .body')
 for(const name of ['分批到达','突发大段','代码与公式']){
  await page.getByRole('button',{name,exact:true}).click()
  await page.getByRole('button',{name:'↻ 重播',exact:true}).click()
  await page.evaluate(()=>{
   window.samples={before:[],after:[]}
   window.observer?.disconnect()
   window.observer=new MutationObserver(()=>{for(const side of ['before','after']){
    const text=document.querySelector(`[data-side=${side}] .body`).textContent
    const samples=window.samples[side]
    if(samples.at(-1)?.text!==text)samples.push({at:performance.now(),text})
   }})
   window.observer.observe(document.querySelector('.comparison'),{subtree:true,childList:true,characterData:true})
  })
  await page.waitForFunction(()=>document.querySelector('main').dataset.running==='false',{},{timeout:15000})
  await page.waitForFunction(()=>document.querySelector('[data-side=before] .body').textContent===document.querySelector('[data-side=after] .body').textContent)
  assert.equal(await before.textContent(),await after.textContent())
  const result=await page.evaluate(()=>{const sizes=side=>window.samples[side].slice(1).map((x,i)=>x.text.length-window.samples[side][i].text.length);return {frames:{before:window.samples.before.length,after:window.samples.after.length},maxStep:{before:Math.max(...sizes('before')),after:Math.max(...sizes('after'))}}})
  assert.ok(result.frames.after>result.frames.before,`${name}: several presentation frames per source batch`)
  if(name!=='代码与公式')assert.ok(result.maxStep.after<result.maxStep.before,`${name}: a smaller largest jump`)
  if(name==='代码与公式'){
   assert.equal(await after.locator('pre').count(),1)
   assert.equal(await after.locator('table').count(),1)
   assert.ok((await after.locator('pre').textContent()).includes('remainingTime'))
   assert.equal(await after.locator('pre [data-xh-stream-piece],table [data-xh-stream-piece]').count(),0)
  }
  reports.push({case:name,...result})
 }
 // Interrupt while text is in flight: flush exactly what's already received.
 await page.getByRole('button',{name:'分批到达',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('main').dataset.source.length>0)
 await page.getByRole('button',{name:'停止回放',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[data-side=after] .body').textContent===document.querySelector('[data-side=before] .body').textContent)
 const stopped=await page.locator('main').getAttribute('data-source')
 await new Promise(r=>setTimeout(r,400))
 assert.equal(await page.locator('main').getAttribute('data-source'),stopped)
 // Reduced-motion preference bypasses the queue in a real browser too.
 await page.emulateMedia({reducedMotion:'reduce'})
 await page.getByRole('button',{name:'↻ 重播',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('main').dataset.source.length>0)
 await page.waitForFunction(()=>document.querySelector('[data-side=after] .body').textContent===document.querySelector('[data-side=before] .body').textContent)
 assert.equal(await after.textContent(),await before.textContent())
 await page.emulateMedia({reducedMotion:'no-preference'})
 await page.getByRole('button',{name:'↻ 重播',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[data-side=after] .body').textContent.length>90)
 if(process.env.STREAM_SCREENSHOT)await page.screenshot({path:process.env.STREAM_SCREENSHOT,fullPage:true})
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,reports,errors,passed:true},null,2))
}finally{await browser.close()}
