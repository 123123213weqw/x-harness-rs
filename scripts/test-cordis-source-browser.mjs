/** Real platform React/primitives and current-master/source Cordis UI A/B.
 * Host facts are controllable observables, not a fake primitive/component layer. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
const deps=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const require=createRequire(resolve(deps,'package.json')),{chromium,webkit}=require('playwright')
const engine=process.env.UI_TEST_BROWSER??'chromium',implementation=process.env.UI_TEST_IMPL??'source',id='@xharness/dsh-client-ui-cordis'
const computerId='@xlang/xharness-client-ui-computer'
const compiled=implementation==='source'?compileSourceModules('ui',[{id:id+'/test',source:'src/modules/cordis/test-exports.ts'},{id:id+'/transcript-seat',source:'src/modules/conversation/chat/TranscriptWindowRow.tsx'},{id:computerId,source:'src/modules/computer/index.tsx'}]):undefined
const code=compiled?compiled.get(id+'/test').bytes.toString():readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8').replace('return module.exports;','Object.assign(exports,{CordisPanel,CordisRunRow,CordisDefineRow});return module.exports;')
const frozenTranscriptHelper=readFileSync('ui/overrides/transcript-windowing.js','utf8')
assert.ok(readFileSync('ui/reference/master-a613970/plugins/@xharness/dsh-client-ui-conversation/client.js','utf8').includes(frozenTranscriptHelper),'exact frozen transcript seat helper')
const browser=await({chromium,webkit}[engine]).launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[]
 page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewPlatform(page,implementation)
 await page.evaluate(()=>document.body.innerHTML='<div id="card" style="width:680px;margin:20px"></div><div id="root" style="position:absolute;left:24px;top:700px;width:280px"></div><button id="outside" style="position:absolute;left:900px;top:700px">outside</button>')
 await page.addScriptTag({content:'window.__ModuleLoader__={load:r=>window.registration=r}'})
 await page.addScriptTag({content:code})
 await page.evaluate(()=>{
  const observable=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set(next){value=typeof next==='function'?next(value):next;listeners.forEach(fn=>fn())}}}
  window.api=registration.factory(name=>{const value=staticModules[name];if(value)return value;throw Error(name)})
  const version=(id,name)=>({packageId:id,name,purpose:'Useful '+name,hasClientHalf:true,hasHostHalf:true})
  window.baseRow={pluginId:'plugin',agentId:'s',packages:[version('v1','First'),version('v2','Second')],currentPackageId:'v1',activeRun:{packageId:'v1',pluginRunId:'run'}}
  window.otherRow={pluginId:'other',agentId:'elsewhere',packages:[version('other-v1','Other')],currentPackageId:'other-v1'}
  window.inventory=observable({rows:[baseRow,otherRow],read:true,removed:new Set()})
  window.activity=observable(new Map());window.runErrors=observable(new Map());window.renderFailures=observable(new Map())
  window.loaded=observable([{pluginId:'plugin',packageId:'v1',pluginRunId:'run'}]);window.sessions=observable({current:'s'});window.cards=observable(new Map())
  const hook=store=>select=>select(React.useSyncExternalStore(store.subscribe,store.getSnapshot))
  window.trace=[];window.refreshed=0;window.resolveAction=null;window.holdNext=false
  const action=async(record)=>{trace.push(record);if(holdNext){holdNext=false;return await new Promise(resolve=>{resolveAction=resolve})}}
  window.panelProps={wide:true,useSessions:hook(sessions),useInventory:hook(inventory),useActiveRuns:hook(activity),useRunErrors:hook(runErrors),useLoaded:hook(loaded),useRenderFailures:hook(renderFailures),onApprove:async(id,future)=>{await action(['approve',id,future]);activity.set(new Map())},onDecline:async id=>{await action(['decline',id]);activity.set(new Map())},onRun:request=>action(['run',request]),onStop:(session,plugin)=>action(['stop',session,plugin]),onRemove:(session,plugin)=>action(['remove',session,plugin]),onRefresh:()=>refreshed++,t:(key,values)=>values?key+':'+JSON.stringify(values):key}
  const block={kind:'tool-result',callId:'c',seq:7,call:{argsRaw:'{"mode":"run"}'},meta:{pluginId:'plugin',packageId:'v1',pluginRunId:'run'},content:[{type:'text',text:'Done'}]}
  window.inspected=0;window.observed=[]
  window.cardProps={callId:'c',toolName:'cordis_run',block,useInventory:hook(inventory),useLoaded:hook(loaded),useRunCards:hook(cards),useActiveRuns:hook(activity),onObserveRunCard:pointer=>observed.push(pointer),inspect:()=>inspected++,renderSlot:(_name,owner,opts)=>React.createElement('button',{'data-owned-business':opts.entryKey,onClick:()=>trace.push(['business',owner])},'Package-owned view'),t:key=>key}
  window.root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(api.CordisPanel,panelProps))
  window.cardRoot=ReactDOM.createRoot(document.getElementById('card'));cardRoot.render(React.createElement(api.CordisRunRow,cardProps))
  window.awaiting=requestId=>activity.set(new Map([['approval',{pluginId:'approval',agentId:'s',packageId:'a-v1',phase:'awaiting-approval',requestId,name:'Approval',purpose:'Needs decision',mode:'run'}]]))
 })
 const badge=page.locator('[data-cordis-badge]'),panel=page.locator('[data-cordis-panel]'),row=page.locator('[data-cordis-row="plugin"]')
 await badge.waitFor();assert.equal(await badge.getAttribute('data-cordis-badge'),'2');assert.equal(await page.locator('[data-tool="cordis_run"]').getAttribute('data-cordis-status'),'running')
 await page.locator('[data-owned-business]').click();await page.getByRole('button',{name:'Inspect',exact:true}).click();assert.equal(await page.evaluate(()=>inspected),1)
 await badge.click();await panel.waitFor();assert.deepEqual(await panel.locator('h3').allTextContents(),['panel.group.current','panel.group.others'])
 await page.evaluate(()=>document.fonts.ready);await page.mouse.move(1000,760)
 const initialPixelsSha256=createHash('sha256').update(await panel.screenshot({animations:'disabled'})).digest('hex')
 assert.equal(await row.getAttribute('data-cordis-status'),'running')
 // Exact package producer selection; selecting v2 is an update, v1 preserves run.
 await row.locator('select').selectOption('v2');await row.locator('[data-cordis-switch="run"]').click()
 assert.deepEqual(await page.evaluate(()=>trace.at(-1)),['run',{agentId:'s',pluginId:'plugin',packageId:'v2',mode:'update',hasClientHalf:true}])
 await row.locator('select').selectOption('v1')
 // Pending actions remain single-flight, with visible failures and retry.
 await page.evaluate(()=>holdNext=true);await row.locator('[data-cordis-switch="stop"]').click()
 assert.equal(await row.locator('[data-cordis-switch="stop"]').isDisabled(),true);assert.equal(await row.locator('select').isDisabled(),true)
 await page.evaluate(()=>resolveAction({ok:false,message:'cannot stop'}));await row.getByRole('alert').waitFor();assert.equal(await row.getByRole('alert').innerText(),'cannot stop')
 await row.locator('[data-cordis-switch="stop"]').click();await page.waitForFunction(()=>!document.querySelector('[data-cordis-row="plugin"] [role="alert"]'))
 await row.locator('[data-cordis-remove]').click();assert.deepEqual(await page.evaluate(()=>trace.at(-1)),['remove','s','plugin'])
 // Both runtime and Host failure sources, held/abdicated render notices.
 await page.evaluate(()=>{runErrors.set(new Map([['plugin',{message:'runtime failed',reason:'exception'}]]));renderFailures.set(new Map([['plugin',{slot:'tool.view.cordis',message:'render failed',abdicated:true}]]))})
 await row.locator('[data-cordis-render-abdicated]').waitFor();assert.ok((await row.innerText()).includes('runtime failed (exception)'))
 await page.evaluate(()=>{runErrors.set(new Map());renderFailures.set(new Map());inventory.set({rows:[{...baseRow,latestRun:{pluginRunId:'bad-run',packageId:'v1',status:'failed',error:{message:'host failed',phase:'load'}}},otherRow],removed:new Set(),read:true})})
 await page.waitForFunction(()=>document.querySelector('[data-cordis-row="plugin"]')?.dataset.cordisStatus==='failed');assert.ok((await row.innerText()).includes('host failed (load)'))
 await page.evaluate(()=>inventory.set({rows:[baseRow,otherRow],removed:new Set(),read:true}))
 await page.locator('#outside').click();assert.equal(await panel.count(),0)
 // New approvals open automatically; each decision closes with unchanged ID/future flag.
 await page.evaluate(()=>awaiting('request-one'));await panel.waitFor();assert.equal(await badge.getAttribute('data-cordis-approval-badge'),'1')
 await page.locator('[data-cordis-approve="request-one"]').click();await page.waitForFunction(()=>!document.querySelector('[data-cordis-panel]'));assert.deepEqual(await page.evaluate(()=>trace.at(-1)),['approve','request-one',false])
 await page.evaluate(()=>awaiting('request-future'));await page.locator('[data-cordis-approve-plugin="request-future"]').click();await page.waitForFunction(()=>!document.querySelector('[data-cordis-panel]'));assert.deepEqual(await page.evaluate(()=>trace.at(-1)),['approve','request-future',true])
 await page.evaluate(()=>awaiting('request-decline'));await page.locator('[data-cordis-decline="request-decline"]').click();await page.waitForFunction(()=>!document.querySelector('[data-cordis-panel]'));assert.deepEqual(await page.evaluate(()=>trace.at(-1)),['decline','request-decline'])
 // Runtime pending vs host-only running, and monotonic latest-card ownership.
 await page.evaluate(()=>loaded.set([]));await page.waitForFunction(()=>document.querySelector('[data-tool="cordis_run"]')?.dataset.cordisStatus==='client-pending');assert.equal(await page.locator('[data-owned-business]').count(),0)
 await page.evaluate(()=>inventory.set({rows:[{...baseRow,packages:baseRow.packages.map(pkg=>({...pkg,hasClientHalf:false}))}],read:true,removed:new Set()}));await page.locator('[data-owned-business]').waitFor()
 await page.evaluate(()=>cards.set(new Map([['plugin.v1',{callId:'newer',seq:8,pluginRunId:'next'}]])));await page.waitForFunction(()=>document.querySelector('[data-tool="cordis_run"]')?.dataset.cordisStatus==='superseded');assert.equal(await page.locator('[data-owned-business]').count(),0)
 await page.evaluate(()=>inventory.set({rows:[],read:true,removed:new Set(['plugin'])}));await page.waitForFunction(()=>document.querySelector('[data-tool="cordis_run"]')?.dataset.cordisStatus==='removed');assert.equal(await badge.count(),0)
 const receipt=await page.evaluate(()=>({trace,observed,inspected,refreshed}))
 await page.evaluate(()=>{root.unmount();cardRoot.unmount();document.body.innerHTML='<div id="root"></div>'})
 await page.addScriptTag({content:'window.__ModuleLoader__={load:r=>window.computerRegistration=r}'})
 await page.addScriptTag({content:compiled?.get(computerId).bytes.toString()??readFileSync(`ui/reference/master-a613970/plugins/${computerId}/client.js`,'utf8')})
 await page.evaluate(()=>{
  const computer=computerRegistration.factory(name=>{if(staticModules[name])return staticModules[name];throw Error(name)})
  computer.apply({effect:fn=>fn(),locale:{register:()=>()=>{}},slots:{inject:(_name,fn)=>fn(),register:(_spec,component)=>{window.ComputerRow=component;return()=>{}}}})
 })
 await page.addScriptTag({content:'window.__ModuleLoader__={load:r=>window.registration=r}'})
 // The real transcript seat owns state, while its heavy Cordis children may be
 // evicted. Two call IDs must retain independent disclosure/source decisions.
 if(compiled){
  await page.addScriptTag({content:compiled.get(id+'/transcript-seat').bytes.toString()})
  await page.evaluate(()=>{window.TranscriptRow=registration.factory(name=>{if(staticModules[name])return staticModules[name];throw Error(name)}).createTranscriptWindowing(React)})
 }else{
  await page.addScriptTag({content:frozenTranscriptHelper+'\nwindow.TranscriptRow=createTranscriptWindowing(React);'})
 }
 await page.evaluate(()=>{
  window.retentionRoot=ReactDOM.createRoot(document.getElementById('root'))
  const props=callId=>({callId,block:{kind:'result',callId,content:[],subCalls:[],call:{argsRaw:JSON.stringify({name:callId,code:{client:'client code '+callId,host:'host code '+callId}})}},t:key=>key,useInventory:f=>f({rows:[],removed:new Set()}),useLoaded:f=>f({})})
  ReactDOM.flushSync(()=>retentionRoot.render(React.createElement('div',{'data-conversation-scroll':'',style:{height:500,width:680,overflow:'auto',overflowAnchor:'none'}},
   React.createElement(TranscriptRow,{'data-retention-seat':'',estimatedHeight:400},
    ...['alpha','beta'].map(callId=>React.createElement('div',{'data-cordis':callId,key:'cordis-'+callId},React.createElement(api.CordisDefineRow,props(callId)))),
    ...['alpha','beta'].map(callId=>React.createElement('div',{'data-computer-seat':callId,key:'computer-'+callId},React.createElement(ComputerRow,{callId,block:{kind:'tool-result',call:{argsRaw:JSON.stringify({action:'click',node_id:'target-'+callId,frame_id:'frame-'+callId})},content:[],isError:false},t:key=>key})))),
   React.createElement('div',{style:{height:15000}},'padding'))))
 })
 const alpha=page.locator('[data-cordis=alpha]'),beta=page.locator('[data-cordis=beta]'),scroll=page.locator('[data-conversation-scroll]')
 const computerAlpha=page.locator('[data-computer-seat=alpha]'),computerBeta=page.locator('[data-computer-seat=beta]')
 await alpha.locator('[aria-expanded]').waitFor();await alpha.locator('[aria-expanded]').click();await alpha.getByRole('tab',{name:'body.hostCode',exact:true}).click()
 await computerAlpha.locator('[aria-expanded]').click();assert.equal(await computerBeta.locator('[aria-expanded=false]').count(),1)
 assert.equal(await beta.locator('[aria-expanded=false]').count(),1)
 await page.evaluate(()=>document.activeElement.blur());await scroll.evaluate(e=>e.scrollTop=e.scrollHeight)
 await page.waitForFunction(()=>document.querySelector('[data-retention-seat]').dataset.transcriptMounted==='false')
 assert.equal(await alpha.count(),0,'Cordis heavy subtree is genuinely evicted')
 assert.equal(await computerAlpha.count(),0,'Computer heavy subtree is genuinely evicted')
 await scroll.evaluate(e=>e.scrollTop=0);await alpha.locator('[aria-expanded=true]').waitFor()
 assert.equal(await alpha.getByRole('tab',{name:'body.hostCode',exact:true}).getAttribute('aria-selected'),'true')
 assert.equal(await beta.locator('[aria-expanded=false]').count(),1,'sibling remains collapsed')
 assert.equal(await computerAlpha.locator('[aria-expanded=true]').count(),1,'Computer expansion survives real heavy remount')
 assert.equal(await computerBeta.locator('[aria-expanded=false]').count(),1,'Computer sibling remains independently collapsed')
 await beta.locator('[aria-expanded]').click();assert.equal(await beta.getByRole('tab',{name:'body.clientCode',exact:true}).getAttribute('aria-selected'),'true')
 await computerBeta.locator('[aria-expanded]').click()
 await page.evaluate(()=>document.activeElement.blur());await scroll.evaluate(e=>e.scrollTop=e.scrollHeight)
 await page.waitForFunction(()=>document.querySelector('[data-retention-seat]').dataset.transcriptMounted==='false')
 await scroll.evaluate(e=>e.scrollTop=0);await alpha.locator('[aria-expanded=true]').waitFor();await beta.locator('[aria-expanded=true]').waitFor()
 assert.equal(await alpha.getByRole('tab',{name:'body.hostCode',exact:true}).getAttribute('aria-selected'),'true')
 assert.equal(await beta.getByRole('tab',{name:'body.clientCode',exact:true}).getAttribute('aria-selected'),'true')
 assert.equal(await computerAlpha.locator('[aria-expanded=true]').count(),1,'first Computer retains expansion through second eviction')
 assert.equal(await computerBeta.locator('[aria-expanded=true]').count(),1,'second Computer retains its own expansion through second eviction')
 const retainedDefinePixelsSha256=createHash('sha256').update(await page.locator('[data-retention-seat]').screenshot({animations:'disabled'})).digest('hex')
 await page.evaluate(()=>retentionRoot.unmount());assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,implementation,actualPlatform:true,initialPixelsSha256,retainedDefinePixelsSha256,approvals:true,versionUpdate:true,pendingSingleFlight:true,actionErrors:true,runtimeAndHostErrors:true,renderFailures:true,outsideDismiss:true,liveAndSupersededBusinessView:true,transcriptDefineEvictionTwice:true,computerEvictionTwice:true,independentCallIds:true,receipt,pageErrors:errors}))
}finally{await browser.close()}
