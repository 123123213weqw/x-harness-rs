/** Real React + production CodeReview + IndexedDB; deterministic slow provider.
 * No user data, credentials, model calls or GitHub mutations.
 */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {compileSourceModules} from './build-source-modules.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const {chromium,webkit}=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium'
const {buildSync}=createRequire(new URL('../ui/package.json',import.meta.url))('esbuild')
const idleSource=buildSync({entryPoints:[new URL('../ui/src/modules/code-review/idle.ts',import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:'IdleFixture',platform:'browser'}).outputFiles[0].text
const browser=await({chromium,webkit}[engine]).launch({headless:true})
const moduleSource=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id:'@xlang/xharness-client-ui-code-review',source:'src/modules/code-review/index.tsx'},{id:'@xharness/dsh-client-ui-conversation',source:'src/modules/conversation/index.ts'}]).get('@xlang/xharness-client-ui-code-review').bytes.toString()
try{
 const page=await browser.newPage({viewport:{width:1180,height:780}}),errors=[]
 page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
 await installOwnedViewHtml(page,'source','<html lang="en"><head></head><body style="margin:0"><div id="root" style="position:fixed;inset:0"></div></body></html>',{origin:'https://review-cache-fixture.test'})
 await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>{window.registration=row}}'})
 await page.addScriptTag({content:moduleSource})
 await page.evaluate(()=>{
  const originalNow=Date.now;window.offset=0;Date.now=()=>originalNow()+offset
  window.account='alice';window.calls={};window.block=true;window.offline=false;window.newHead=false
  const record={id:7,repository:'alice/project',title:'Cached PR',author:'alice',updatedAt:'2026-10-04T00:00:00Z',state:'open',draft:false,headSha:'a'.repeat(40),branch:'topic',body:'Last good description',baseBranch:'main',additions:3,deletions:1,changedFiles:1,mergeable:null,mergeableState:'unknown',files:[{path:'example.ts',status:'added',patch:'+export const value = 1',additions:1,deletions:0}],comments:[],reviews:[],checks:[{id:'ci',name:'Test CI',status:'in_progress',conclusion:null,description:''}],filesHasMore:false,commentsHasMore:false,reviewsHasMore:false,checksTruncated:false,inlineCommentCount:0,commentCount:0}
  const rpc={call:async(_channel,endpoint)=>{
   calls[endpoint]=(calls[endpoint]??0)+1
   if(endpoint==='github/auth')return {ok:true,value:{account,source:'github-cli'}}
   if(offline)return {ok:false,error:{code:'internal',message:'Provider temporarily offline',details:{kind:'transport'}}}
   if(endpoint==='github/repos')return {ok:true,value:{items:[`${account}/project`],hasMore:false}}
   if(endpoint==='github/pulls')return {ok:true,value:{items:account==='alice'?[{...record,headSha:newHead?'b'.repeat(40):record.headSha}]:[],hasMore:false}}
   if(endpoint==='github/detail'){if(block)await new Promise(resolve=>window.release=resolve);return {ok:true,value:{...record,headSha:newHead?'b'.repeat(40):record.headSha}}}
   throw Error(endpoint)
  }}
  const feature=registration.factory(id=>{if(id in staticModules)return staticModules[id];throw Error(id)})
  const root=ReactDOM.createRoot(document.getElementById('root'));let Component,props,dispose
  window.create=()=>{
   const ctx={get:name=>name==='connection'?{rpc}:name==='sessions'?{list:{getSnapshot:()=>({ids:[],byId:{}}),subscribe:()=>()=>{}}}:name==='workspaces'?{list:{getSnapshot:()=>({items:[]}),subscribe:()=>()=>{}}}:{input:{}},effect:(fn,label)=>{if(label.includes('idle'))return;fn()},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>{if(spec.name==='review.center'){Component=component;props=spec.inject();window.cache=props.cache;dispose=()=>props.cache.dispose()}}}}
   feature.apply(ctx)
  }
  window.mount=()=>root.render(React.createElement(Component,{...props,close:()=>root.render(null)}))
  window.unmount=()=>root.render(null)
  window.recreate=async()=>{await cache.flush();dispose();create();mount()}
  create();mount()
 })
 const pr=()=>page.getByRole('button',{name:/Cached PR/}),description=()=>page.getByText('Last good description',{exact:true})
 await pr().waitFor();await pr().click()
 await page.getByRole('heading',{name:'Cached PR',exact:true}).waitFor()
 assert.equal(await description().count(),0,'known summary appears before delayed full detail')
 await page.waitForFunction(()=>typeof release==='function');await page.evaluate(()=>{block=false;release()});await description().waitFor()
 assert.equal(await page.evaluate(()=>calls['github/detail']),1)
 await page.getByRole('tab',{name:/Changes/}).click();await page.getByText('+export const value = 1',{exact:false}).waitFor()
 await page.evaluate(()=>unmount());await page.locator('main.xhreview').waitFor({state:'detached'});await page.evaluate(()=>mount());await pr().waitFor()
 const start=Date.now();await pr().click();await description().waitFor();const warmMs=Date.now()-start
 assert.equal(await page.evaluate(()=>calls['github/detail']),1,'fresh detail hit makes no redundant request')
 await page.evaluate(()=>{offset+=61_000;block=true;release=undefined})
 await page.evaluate(()=>unmount());await page.locator('main.xhreview').waitFor({state:'detached'});await page.evaluate(()=>mount());await pr().waitFor();await pr().click();await description().waitFor()
 await page.getByText('Refreshing cached data…',{exact:true}).waitFor();await page.waitForFunction(()=>typeof release==='function')
 assert.equal(await page.evaluate(()=>calls['github/detail']),2,'expired entry shows instantly while request stays blocked')
 await page.evaluate(()=>{block=false;release()});await page.getByText('Refreshing cached data…',{exact:true}).waitFor({state:'detached'})
 // Recreate the module cache, like app restart. Restore uses actual IndexedDB.
 await page.evaluate(()=>unmount());await page.locator('main.xhreview').waitFor({state:'detached'});await page.evaluate(()=>recreate());await pr().waitFor();await pr().click();await description().waitFor()
 assert.equal(await page.evaluate(()=>calls['github/detail']),2,'restart hydrates original freshness instead of redownloading detail')
 // Failed stale refresh retains same-PR data but never claims CI is current.
 await page.evaluate(()=>{offset+=61_000;offline=true});await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('alert').filter({hasText:'Provider temporarily offline'}).first().waitFor();await description().waitFor();await page.getByText('Cached data. Refresh required.',{exact:true}).waitFor()
 // Manual refresh must bypass once, not permanently disable fresh reuse.
 await page.evaluate(()=>{offline=false});await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Cached data. Refresh required.',{exact:true}).waitFor({state:'detached'});await page.getByText('Refreshing cached data…',{exact:true}).waitFor({state:'detached'})
 const refreshed=await page.evaluate(()=>calls['github/detail']);await pr().click();await description().waitFor();assert.equal(await page.evaluate(()=>calls['github/detail']),refreshed,'fresh reuse still works after explicit refresh')
 // Explicit reconnect clears both memory and disk; another account cannot see Alice.
 await page.evaluate(()=>{offline=false;account='bob'});await page.getByRole('button',{name:'Reconnect',exact:true}).click();await page.getByText('No matching pull requests',{exact:true}).waitFor();assert.equal(await description().count(),0);assert.equal(await pr().count(),0)
 await page.evaluate(()=>unmount());await page.locator('main.xhreview').waitFor({state:'detached'});await page.evaluate(()=>recreate());await page.getByText('No matching pull requests',{exact:true}).waitFor();assert.equal(await description().count(),0)
 // Exercise actual requestIdleCallback / WebKit RAF fallback and DOM input hooks.
 await page.addScriptTag({content:idleSource})
 await page.evaluate(()=>{
  window.visible=false;window.connected=true;window.idleCalls=[]
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'})
  Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>connected})
  window.idleQueue=new IdleFixture.ReviewIdleQueue(new IdleFixture.BrowserIdleEnvironment())
  idleQueue.enqueue('held',async signal=>{window.speculativeSignal=signal;idleCalls.push('held');await new Promise(resolve=>window.finishHeld=resolve)})
 })
 await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>idleCalls),[],'hidden page does not start work')
 await page.evaluate(()=>{visible=true;document.dispatchEvent(new Event('visibilitychange'))})
 await page.waitForFunction(()=>typeof finishHeld==='function')
 await page.mouse.click(10,10);assert.equal(await page.evaluate(()=>speculativeSignal.aborted),true,'real pointer input aborts background work')
 await page.evaluate(()=>{idleQueue.remove('held');connected=false;window.dispatchEvent(new Event('offline'));idleQueue.enqueue('next',async()=>idleCalls.push('next'));finishHeld()})
 await page.waitForTimeout(1700);assert.deepEqual(await page.evaluate(()=>idleCalls),['held'],'offline queue remains suspended')
 await page.evaluate(()=>{connected=true;window.dispatchEvent(new Event('online'))});await page.waitForFunction(()=>idleCalls.includes('next'));await page.evaluate(()=>idleQueue.dispose())
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,warmClickToDescriptionMs:warmMs,freshDetailRequests:0,staleImmediateWhileBlocked:true,indexedDBRestart:true,offlineStaleWarning:true,accountIsolation:true,summaryBeforeDetail:true,realIdleScheduler:true,hiddenOfflineSuspension:true,inputAbort:true,pageErrors:errors}))
}finally{await browser.close()}
