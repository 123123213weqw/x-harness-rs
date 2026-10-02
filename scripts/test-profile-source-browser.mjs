// Latest-master Profile: pending cold-start totals must not be labelled final.
import assert from 'node:assert/strict'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
const deps=resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'),require=createRequire(resolve(deps,'package.json')),engine=process.env.UI_TEST_BROWSER??'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const source=ownedViewModuleTestInput('@xlang/xharness-client-ui-profile'),browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:980,height:760}}),errors=[];page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)});await installOwnedViewPlatform(page,process.env.UI_TEST_IMPL==='legacy'?'legacy':'source');await page.evaluate(()=>document.body.innerHTML='<div id="root"></div>')
 await page.addScriptTag({content:`window.__ModuleLoader__={load({factory}){window.profile=factory(name=>{if(name==='react')return React;throw Error(name)})}};`})
 await page.addScriptTag({content:source})
 await page.evaluate(()=>{
  let dictionaries,section;window.cleanup=[];window.listeners=new Set();window.snapshot={byId:{cold:{id:'cold',projectionValues:{sessionListMetadata:{metricsPending:true}}}}};window.language='en'
  const list={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}
  const ctx={effect:fn=>{const dispose=fn();if(typeof dispose==='function')cleanup.push(dispose)},locale:{register:(_ns,value)=>{dictionaries=value},bind:()=>key=>dictionaries[language][key]},sessions:{list},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>{section={spec,component}}}}
  profile.apply(ctx);window.mount=ReactDOM.createRoot(document.getElementById('root'));window.render=()=>mount.render(React.createElement(section.component,{...section.spec.inject(),t:ctx.locale.bind()}));window.publish=byId=>{snapshot={byId};for(const fn of listeners)fn()};render()
 })
 const root=page.locator('.xhp-root'),status=root.getByRole('status');await status.getByText(/Restoring historical usage.*1 Chats.*Partial totals/).waitFor();assert.equal(await root.getByText('No reported token usage yet.').count(),0)
 await page.evaluate(()=>publish({cold:{id:'cold',projectionValues:{sessionListMetadata:{metricsPending:true},dailyTokenUsage:[{dayStartMs:Date.UTC(2026,9,1),uncachedInputTokens:20,cacheReadTokens:30,cacheWriteTokens:0,outputTokens:5}]}}}))
 await root.locator('.xhp-stat strong').first().getByText('55',{exact:true}).waitFor();await status.getByText(/Partial totals/).waitFor();await page.evaluate(()=>document.fonts.ready);const initialPixelsSha256=createHash('sha256').update(await root.screenshot({animations:'disabled'})).digest('hex')
 await root.getByRole('button',{name:'Weekly',exact:true}).click();await root.getByRole('img',{name:'Weekly',exact:true}).waitFor();assert.equal(await root.locator('.xhp-week-bar').count(),26)
 await root.getByRole('button',{name:'Cumulative',exact:true}).click();await root.getByRole('img',{name:'Cumulative',exact:true}).waitFor()
 await root.getByRole('button',{name:'Daily',exact:true}).click();assert.equal(await root.locator('.xhp-cell').count(),182)
 await page.evaluate(()=>publish({cold:{id:'cold',projectionValues:{sessionListMetadata:{metricsPending:false},dailyTokenUsage:[{dayStartMs:Date.UTC(2026,9,1),uncachedInputTokens:20,cacheReadTokens:30,cacheWriteTokens:0,outputTokens:5}]}}}))
 await status.waitFor({state:'detached'});assert.equal(await root.locator('.xhp-stat strong').first().innerText(),'55')
 await page.evaluate(()=>{language='zh';render();publish({other:{id:'other',projections:{values:{sessionListMetadata:{metricsPending:true}}}}})})
 await status.getByText(/正在后台恢复历史用量.*1 会话数.*当前为部分统计/).waitFor();assert.equal(await root.getByText('还没有可统计的 Token 用量。').count(),0)
 await page.evaluate(()=>{mount.unmount();for(const fn of cleanup)fn()});assert.equal(await page.locator('#xharness-profile-style').count(),0);assert.equal(await page.evaluate(()=>listeners.size),0);assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,implementation:process.env.UI_TEST_IMPL??'canonical',actualPlatform:true,initialPixelsSha256,pendingColdStart:true,partialMeasuredTotals:true,dailyWeeklyCumulative:true,pendingCompletion:true,zhProjectionFallback:true,styleAndSubscriptionCleanup:true,pageErrors:errors}))
}finally{await browser.close()}
