import {installWorkCatalogFixture} from './fixtures/work-catalog-browser.mjs'
/** Actual shell + Tasks + schedule slots. Isolated fixture, no personal data or model calls. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const {chromium,webkit}=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await({chromium,webkit}[engine]).launch({headless:true})
try {
  const page=await browser.newPage({viewport:{width:1120,height:780}}),errors=[],requests=[]
  page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  let mode='records',release,projectionSeq=0
  const records={items:[{sessionId:'chat-1',blank:false,running:false,updatedAt:Date.now(),projections:{asOfSeq:0,values:{title:'Test chat',schedules:[{id:'one',prompt:'<img src=x onerror=alert(1)>',kind:'every',everySeconds:60,scheduledAt:'2026-10-04T12:00:00Z'}]}}}]}
  await installOwnedViewHtml(page,'source','<html lang="en"><head></head><body style="margin:0"><div id="root" style="position:fixed;inset:0"></div></body></html>',{origin:'https://owned-platform-fixture.test'})
  await page.route('**/api/*',async route=>{
    const body=route.request().postDataJSON();requests.push(body);const requested=mode
    if(body.method==='session.list'&&requested==='delayed')await new Promise(resolve=>release=resolve)
    if(body.method==='session.list'&&requested==='error')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:false,error:{code:'internal',message:'offline',details:{}}}})})
    const value=body.method==='workspace.list'?{items:[],archivedSessionIds:[],archivedSessions:[]}:requested==='records'||requested==='delayed'?records:requested==='partial'?{items:[{sessionId:'unknown-chat',blank:false,running:false,updatedAt:0}]}:{items:[]}
    if(body.method==='session.list'&&['records','delayed'].includes(requested))value.items[0].projections.asOfSeq=++projectionSeq
    await route.fulfill({contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value}})}).catch(()=>{})
  })
  await installWorkCatalogFixture(page)
  await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>{window.registrations??={};registrations[row.id]=row}}'})
  for(const id of ['@xharness/dsh-client-runtime','@xharness/dsh-client-ui-layout','@xlang/xharness-client-ui-tasks','@xlang/xharness-client-ui-schedule'])await page.addScriptTag({content:ownedViewModuleTestInput(id)})
  await page.evaluate(()=>{
    const runtime=registrations['@xharness/dsh-client-runtime'].factory(id=>{if(id in staticModules)return staticModules[id];throw Error(id)})
    const get=id=>{if(id==='@xharness/dsh-client-runtime/client')return runtime;if(id in staticModules)return staticModules[id];throw Error(id)}
    const slots=new Map(),cleanup=[]
    const ctx={get:name=>name==='workCatalog'?workCatalog:undefined,effect:fn=>{const off=fn();if(typeof off==='function')cleanup.push(off)},locale:{register:()=>{}},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>slots.set(spec.name,component)},conversationEvents:{register:()=>{}},conversationViews:{register:()=>{}}}
    for(const id of ['@xlang/xharness-client-ui-tasks','@xlang/xharness-client-ui-schedule'])registrations[id].factory(get).apply(ctx)
    let Frame,definition
    registrations['@xharness/dsh-client-ui-layout'].factory(get).apply({effect:(fn,label)=>{if(label.includes('service'))fn()},reflect:{provide:()=>()=>{}},slots:{register:(spec,component)=>{definition=spec;Frame=component;return()=>{}}}})
    const instance=definition.store().create();definition.inject(instance.actions)
    window.opened=[];window.mounts=0
    window.addEventListener('xharness:work:open-session',event=>opened.push(event.detail))
    function Chat(){const [draft,setDraft]=React.useState('');React.useEffect(()=>{mounts++},[]);return React.createElement('textarea',{'aria-label':'Chat draft',value:draft,onChange:event=>setDraft(event.target.value)})}
    const renderSlot=(name,props)=>{
      if(name==='sidebar')return React.createElement('nav',null,
        React.createElement('button',{'data-xharness-work-nav':true,onClick:()=>window.dispatchEvent(new Event('xharness:work:open'))},'Clock'),
        React.createElement('button',{'data-xharness-plugin-nav':true,onClick:()=>window.dispatchEvent(new Event('xharness:plugins:open'))},'Plugins'),
        React.createElement('button',{'data-sidebar-toggle':true,onClick:()=>{}},'Collapse sidebar'),React.createElement('button',null,'Other chat'))
      if(name==='conversation')return React.createElement(Chat)
      if(name==='plugins.center')return React.createElement('h1',null,'Plugin catalog')
      const component=slots.get(name);return component?React.createElement(component,props):null
    }
    window.root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(Frame,{useStore:fn=>fn(React.useSyncExternalStore(instance.subscribe,instance.getSnapshot)),useSessions:fn=>fn({current:'chat-1',byId:{'chat-1':{blank:false}}}),actions:instance.actions,renderSlot}))
  })
  await page.getByRole('textbox',{name:'Chat draft'}).fill('Keep this draft')
  const clock=page.getByRole('button',{name:'Clock',exact:true}),main=page.getByRole('main',{name:'Tasks and automations'})
  await clock.click();await main.waitFor();assert.equal(await page.getByRole('menu').count(),0);assert.equal(await page.getByRole('dialog').count(),0)
  await main.getByRole('button',{name:'Test chat',exact:true}).waitFor({timeout:5000}).catch(async error=>{console.error(JSON.stringify({requests,errors,debug:await page.evaluate(()=>({text:document.body.innerText,catalog:workCatalog.getSnapshot(),sessions:workManagers.sessions.getListSnapshot(),workspaces:workManagers.workspaces.getSnapshot()}))}));throw error});assert.equal(await main.getByRole('tab',{name:'Tasks',exact:true}).getAttribute('aria-selected'),'true')
  const beforeTaskLive=requests.length
  await page.evaluate(seq=>{
    workManagers.sessions.handleHostEnvelope({rpcId:'running',payload:{type:'host/session-status',sessionId:'chat-1',running:true}})
    workManagers.sessions.handleMuxEnvelope({rpcId:'title',payload:{type:'session/projection',sessionId:'chat-1',key:'title',seq,value:'Live title'}})
  },++projectionSeq)
  await main.getByRole('button',{name:'Live title',exact:true}).waitFor();await main.locator('.xhtask-dot-running').waitFor()
  assert.equal(requests.length,beforeTaskLive,'Tasks observes existing live owners without another read')
  await page.evaluate(seq=>{
    workManagers.sessions.handleHostEnvelope({rpcId:'idle',payload:{type:'host/session-status',sessionId:'chat-1',running:false}})
    workManagers.sessions.handleMuxEnvelope({rpcId:'restore-title',payload:{type:'session/projection',sessionId:'chat-1',key:'title',seq,value:'Test chat'}})
  },++projectionSeq)
  await main.getByRole('button',{name:'Test chat',exact:true}).waitFor()
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();assert.equal(await main.count(),1,'sidebar toggle keeps work page')
  await main.getByRole('tab',{name:'Automations',exact:true}).click();await main.getByText(records.items[0].projections.values.schedules[0].prompt,{exact:true}).waitFor()
  assert.equal(await main.locator('img').count(),0,'prompt remains escaped text');assert.equal(await main.getByText(/Every 60s/).count(),1)
  await main.getByRole('tab',{name:'Automations',exact:true}).press('ArrowLeft');await main.getByRole('button',{name:'Test chat',exact:true}).waitFor();assert.equal(await main.getByRole('tab',{name:'Tasks',exact:true}).evaluate(node=>node===document.activeElement),true)
  await main.getByRole('tab',{name:'Tasks',exact:true}).press('End');await main.getByText(/Every 60s/).waitFor()
  const beforeLive=requests.length
  await page.evaluate(seq=>workManagers.sessions.handleMuxEnvelope({rpcId:'live',payload:{type:'session/projection',sessionId:'chat-1',key:'schedules',seq,value:[]}}),++projectionSeq)
  await main.getByText('No automations yet',{exact:true}).waitFor()
  assert.equal(requests.length,beforeLive,'live schedule completion needs no extra read or history')
  await page.evaluate(seq=>workManagers.sessions.handleMuxEnvelope({rpcId:'stale',payload:{type:'session/projection',sessionId:'chat-1',key:'schedules',seq,value:[{id:'stale',prompt:'Stale task',kind:'at',scheduledAt:'2026-10-04T12:00:00Z'}]}}),projectionSeq-1)
  assert.equal(await main.getByText('Stale task',{exact:true}).count(),0,'projection sequence fence retains completion')
  mode='partial';await main.getByRole('button',{name:'Refresh automations'}).click();await main.getByText('No loaded automations',{exact:true}).waitFor();await main.getByText(/Some chats/).waitFor()
  mode='error';await main.getByRole('button',{name:'Refresh automations'}).click();await main.getByRole('alert').getByText(/offline/).waitFor();assert.equal(await main.getByText('No automations yet',{exact:true}).count(),0)
  mode='records';const beforeReconnect=requests.length
  await page.evaluate(()=>{workManagers.sessions.handleDisconnected();workManagers.sessions.handleConnected();workManagers.workspaces.handleConnected()})
  await main.getByText(/Every 60s/).waitFor();await main.getByRole('alert').waitFor({state:'detached'})
  assert.equal(requests.length,beforeReconnect+2,'existing reconnect owners perform one pull each')
  mode='empty';await main.getByRole('button',{name:'Refresh automations'}).click();await main.getByText('No automations yet',{exact:true}).waitFor()
  mode='delayed';await main.getByRole('button',{name:'Refresh automations'}).click();await main.getByRole('status').waitFor();while(!release)await new Promise(resolve=>setTimeout(resolve,10))
  const releaseOld=release;mode='empty';await main.getByRole('tab',{name:'Tasks',exact:true}).click();await main.getByRole('tab',{name:'Automations',exact:true}).click();await main.getByRole('status').waitFor();releaseOld();await main.getByText(/Every 60s/).waitFor();await main.getByRole('button',{name:'Refresh automations'}).click();await main.getByText('No automations yet',{exact:true}).waitFor()
  release=undefined;mode='delayed'
  await page.evaluate(()=>{window.originalWorkTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>originalWorkTimeout(fn,ms===15_000?50:ms,...args)})
  await main.getByRole('button',{name:'Refresh automations'}).click();await main.getByRole('alert').getByText(/Request timed out/).waitFor()
  assert.equal(typeof release,'function','reader timeout leaves the actual shared pull running')
  await page.evaluate(()=>{window.setTimeout=originalWorkTimeout});release()
  await main.getByText(/Every 60s/).waitFor();await main.getByRole('alert').waitFor({state:'detached'})
  mode='records';await main.getByRole('button',{name:'Refresh automations'}).click();await main.getByRole('button',{name:'Test chat',exact:true}).click();await main.waitFor({state:'detached'});assert.deepEqual(await page.evaluate(()=>opened),['chat-1']);assert.equal(await page.getByRole('textbox',{name:'Chat draft'}).inputValue(),'Keep this draft');assert.equal(await page.evaluate(()=>mounts),1,'navigation does not remount chat')
  await clock.click();await main.getByRole('button',{name:'Test chat',exact:true}).click();await main.waitFor({state:'detached'});assert.deepEqual(await page.evaluate(()=>opened),['chat-1','chat-1'],'task opens its real session')
  await clock.click();await page.getByRole('button',{name:'Plugins',exact:true}).click();await page.getByRole('heading',{name:'Plugin catalog'}).waitFor();assert.equal(await main.count(),0,'only one center page');await clock.click();await main.waitFor()
  await main.getByRole('button',{name:'Back to chat',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Chat draft'}).inputValue(),'Keep this draft')
  await clock.click();await page.getByRole('button',{name:'Other chat',exact:true}).click();assert.equal(await main.count(),0)
  await page.setViewportSize({width:390,height:664});await clock.click();await main.waitFor();const box=await main.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);assert.equal(await page.locator('.xhtask-scrim,.xhtask-panel-wrap,.xhauto-scrim,.xhauto-panel').count(),0)
  assert.ok(requests.every(row=>['session.list','workspace.list'].includes(row.method)),'navigation never mutates runtime');assert.deepEqual(errors,[])
  console.log(JSON.stringify({engine,fullPage:true,twoTabs:true,keyboardTabs:true,noDrawers:true,taskSessionRouting:true,scheduleSessionRouting:true,draftRetained:true,unknownAndErrorStates:true,abortAndStaleFence:true,exclusiveNavigation:true,mobile:true,readOnly:true,liveTasks:true,liveSchedules:true,reconnectRecovery:true,timeoutLateSuccess:true,pageErrors:errors}))
}finally{await browser.close()}
