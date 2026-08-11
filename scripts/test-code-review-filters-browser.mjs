/** Production feature in isolated real React + IndexedDB; no user data or GitHub network. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {compileSourceModules} from './build-source-modules.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const {chromium,webkit}=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium',browser=await({chromium,webkit}[engine]).launch({headless:true})
const source=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id:'@xlang/xharness-client-ui-code-review',source:'src/modules/code-review/index.tsx'},{id:'@xharness/dsh-client-ui-conversation',source:'src/modules/conversation/index.ts'}]).get('@xlang/xharness-client-ui-code-review').bytes.toString()
try{
 const page=await browser.newPage({viewport:{width:1180,height:780},locale:'en-US'}),errors=[];page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewHtml(page,'source','<html lang="en"><head></head><body style="margin:0"><div id="root" style="position:fixed;inset:0"></div></body></html>',{origin:'https://review-filters.test'})
 await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>{window.registration=row}}'});await page.addScriptTag({content:source})
 await page.evaluate(()=>{
  window.account='alice';window.calls=[];window.blocked=false;window.released=undefined
  const summary=(id,repository,author)=>({id,repository,author,title:author==='alice'?'Owned PR':'Other PR',updatedAt:'2026-10-04T00:00:00Z',state:'open',draft:false,headSha:'a'.repeat(40),branch:'topic'})
  const rpc={call:async(_channel,method,payload)=>{
   calls.push({method,args:payload.args});const args=payload.args
   if(method==='github/auth')return {ok:true,value:{account,source:'github-cli'}}
   if(method==='github/repos')return {ok:true,value:{items:args.page===1?[`${account}/project`,`${account}/secondary`,'org/project',...Array.from({length:45},(_,i)=>`org/repository-${i}`)]:['org/loaded-next-page'],hasMore:args.page===1}}
   if(method==='github/pulls'){if(blocked&&args.repository==='alice/secondary')await new Promise(resolve=>released=resolve);return {ok:true,value:{items:[summary(7,args.repository,'alice'),summary(8,args.repository,'bob')],hasMore:false}}}
   throw Error(method)
  }}
  const feature=registration.factory(id=>{if(id in staticModules)return staticModules[id];throw Error(id)}),root=ReactDOM.createRoot(document.getElementById('root'));let Component,props
  const create=()=>feature.apply({get:name=>name==='connection'?{rpc}:name==='sessions'?{list:{getSnapshot:()=>({ids:[],byId:{}}),subscribe:()=>()=>{}}}:name==='workspaces'?{list:{getSnapshot:()=>({items:[]}),subscribe:()=>()=>{}}}:{input:{}},effect:(fn,label)=>{if(!label.includes('idle'))fn()},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>{if(spec.name==='review.center'){Component=component;props=spec.inject();props.chat=undefined /* Cache/filter-only fixture; chat has its own integration test. */}}}})
  window.mount=()=>root.render(React.createElement(Component,{...props,close:()=>root.render(null)}));window.unmount=()=>root.render(null)
  window.recreate=async()=>{await props.preferences.flush();props.cache.dispose();create();mount()};create();mount()
 })
 const repo=()=>page.getByRole('button',{name:/^Repository:/}),picker=()=>page.getByRole('dialog',{name:'Choose repository'}),search=()=>page.getByRole('combobox',{name:'Search repositories'})
 await repo().waitFor();await page.getByRole('button',{name:/Owned PR/}).waitFor();assert.equal(await page.locator('.xhreview-list select').count(),0)
 await repo().click();await search().waitFor();assert.equal(await search().evaluate(e=>e===document.activeElement),true)
 assert.equal(await page.getByRole('option',{name:'alice/project',exact:true}).getAttribute('aria-selected'),'true')
 await search().fill(' SECONDARY ');assert.equal(await page.getByRole('option').count(),1);await search().press('Enter');await picker().waitFor({state:'detached'});assert.equal(await repo().getAttribute('title'),'alice/secondary');assert.equal(await repo().evaluate(e=>e===document.activeElement),true)
 await repo().click();await page.getByRole('group',{name:'Recently used'}).waitFor();await search().fill('org/project');await search().press('Escape');await picker().waitFor({state:'detached'});assert.equal(await repo().getAttribute('title'),'alice/secondary')
 await repo().press('ArrowDown');await search().waitFor();await search().fill('nothing');await page.getByText('No matching repositories',{exact:true}).waitFor();await search().press('Enter');assert.equal(await picker().count(),1)
 await search().fill('org/project');await search().press('ArrowDown');await search().press('Enter');await picker().waitFor({state:'detached'});assert.equal(await repo().getAttribute('title'),'org/project')
 await repo().click();await page.getByRole('button',{name:'Load more repositories'}).click();await page.getByRole('option',{name:'org/loaded-next-page',exact:true}).waitFor();await search().fill('loaded-next');await search().press('Enter');await picker().waitFor({state:'detached'})
 await page.getByRole('button',{name:/Owned PR/}).waitFor();await page.getByRole('button',{name:/Other PR/}).waitFor()
 const before=await page.evaluate(()=>calls.filter(c=>c.method==='github/pulls').length)
 await page.getByRole('radio',{name:'Authored by me',exact:true}).click();await page.getByRole('button',{name:/Other PR/}).waitFor({state:'detached'});assert.equal(await page.getByRole('radio',{name:'Authored by me'}).getAttribute('aria-checked'),'true')
 await page.getByRole('radio',{name:'Authored by me'}).press('ArrowLeft');await page.getByRole('button',{name:/Other PR/}).waitFor();assert.equal(await page.getByRole('radio',{name:'All',exact:true}).evaluate(e=>e===document.activeElement),true)
 await page.getByRole('radio',{name:'All',exact:true}).press('ArrowRight');await page.getByRole('button',{name:/Other PR/}).waitFor({state:'detached'});assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='github/pulls').length),before,'author filter makes no extra request')
 await page.evaluate(()=>unmount());await page.locator('main.xhreview').waitFor({state:'detached'});await page.evaluate(()=>recreate());await repo().waitFor();assert.equal(await repo().getAttribute('title'),'org/loaded-next-page');assert.equal(await page.getByRole('radio',{name:'Authored by me'}).getAttribute('aria-checked'),'true')
 // Reconnect reloads GitHub data, not the user's same-account selection.
 await page.getByRole('button',{name:'Reconnect',exact:true}).click();await repo().waitFor();assert.equal(await repo().getAttribute('title'),'org/loaded-next-page')
 await repo().click();await search().waitFor();await page.getByRole('heading',{name:'Select a pull request',exact:true}).click();await picker().waitFor({state:'detached'})
 await page.setViewportSize({width:540,height:720});await repo().click();await search().waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no mobile horizontal overflow');await search().press('Escape')
 await page.evaluate(()=>account='bob');await page.getByRole('button',{name:'Reconnect',exact:true}).click();await page.getByRole('button',{name:'Repository: bob/project',exact:true}).waitFor();assert.equal(await page.getByRole('radio',{name:'All',exact:true}).getAttribute('aria-checked'),'true');await repo().click();assert.equal(await page.getByRole('group',{name:'Recently used'}).count(),0)
 assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,searchAndSelection:true,recentGrouping:true,focusRestoration:true,escapeOutsideDismiss:true,keyboard:true,pagination:true,authorFilterNoNetwork:true,accountIsolation:true,persistentChoice:true,mobileOverflow:false,pageErrors:errors}))
}finally{await browser.close()}
