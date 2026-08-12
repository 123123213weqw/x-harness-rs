import {installWorkCatalogFixture} from './fixtures/work-catalog-browser.mjs'
/** Complete latest Tasks/ArchivedSettings ModuleLoader factory in real React.
 * Same scenarios execute frozen master and source, with original platform SVGs. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
import {createHash} from 'node:crypto'
const deps=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const require=createRequire(resolve(deps,'package.json'))
const {chromium,webkit}=require('playwright')
const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await({chromium,webkit}[engine]).launch({headless:true})
try {
  const page=await browser.newPage({viewport:{width:1120,height:900}})
  const errors=[]; page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)});await installOwnedViewPlatform(page,process.env.UI_TEST_IMPL==='legacy'?'legacy':'source',{origin:'https://owned-platform-fixture.test'})
  const now=1789278451000
  const archived=new Map([
    ['alpha',{sessionId:'alpha',title:'Original Alpha',updatedAt:now+50}],
    ['beta-parent',{sessionId:'beta-parent',title:'Beta parent',updatedAt:now+40}],
    ['beta-child',{sessionId:'beta-child',title:'Beta child',updatedAt:now+30}],
    ['orphan',{sessionId:'orphan',title:'Loose archived chat',updatedAt:now+20}],
  ])
  const workspaces=[{workspaceId:'a',title:'Alpha',sessionIds:['alpha'],path:'/a',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z'}, {workspaceId:'b',title:'Beta',sessionIds:['beta-parent','beta-child'],path:'/b',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z'}]
  const live=[{sessionId:'live',updatedAt:now,projections:{values:{title:'Live chat'}}}]
  let freezeNextBaseline=false, frozenBaselineEntered=false, releaseFrozenBaseline, failWorkspaceRefresh=false
  const frozenBaselineGate=new Promise(resolve=>{releaseFrozenBaseline=resolve})
  const requests=[]; let denyOrphan=true, renameStarted=false, releaseRename
  const renameGate=new Promise(resolve=>{releaseRename=resolve})
  await page.route('**/api/*',async route=>{
    const body=route.request().postDataJSON(); const {method,payload}=body;requests.push({method,payload})
    let value=null,error
    if(method==='session.list')value={items:live.map(row=>({...row,blank:false,running:false,projections:{asOfSeq:0,...row.projections}}))}
    else if(method==='workspace.list'){value={items:workspaces,archivedSessionIds:[...archived.keys()],archivedSessions:[...archived.values()]};if(failWorkspaceRefresh)error='archive baseline offline';if(freezeNextBaseline){freezeNextBaseline=false;frozenBaselineEntered=true;await frozenBaselineGate}}
    else if(method==='session.rename') {renameStarted=true;await renameGate;value={title:payload.title,seq:1}}
    else if(method==='workspace.unarchiveSession') { const saved=archived.get(payload.sessionId); if(saved){archived.delete(payload.sessionId);live.push({sessionId:saved.sessionId,updatedAt:saved.updatedAt,projections:{values:{title:saved.title}}})} value={archivedSessionIds:[...archived.keys()]} }
    else if(method==='session.delete') {
      if(payload.sessionId==='beta-parent'&&archived.has('beta-child'))error='archived child must be deleted first'
      else if(payload.sessionId==='orphan'&&denyOrphan)error='host rejects deletion'
      else {value={deleted:archived.delete(payload.sessionId)}}
    } else if(method==='workspace.archiveSession') { const index=live.findIndex(row=>row.sessionId===payload.sessionId); const [row]=live.splice(index,1);if(row)archived.set(row.sessionId,{sessionId:row.sessionId,title:row.projections.values.title,updatedAt:row.updatedAt});value={archivedSessionIds:[...archived.keys()]} }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:body.rpcId,result:error?{ok:false,error:{code:'internal',message:error,details:{}}}:{ok:true,value}})})
  })
  await page.addStyleTag({content:':root{--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-border-l2:#ddd;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-2:#fafafa}body{font:14px system-ui;margin:24px}#root{max-width:1000px}'})
  await page.evaluate(()=>document.body.innerHTML='<div id="root"></div>')
  if(process.env.UI_TEST_IMPL!=='legacy')await installWorkCatalogFixture(page)
  await page.addScriptTag({content:'window.__registrations={};window.__ModuleLoader__={load:r=>__registrations[r.id]=r}'})
  await page.addScriptTag({content:ownedViewModuleTestInput('@xlang/xharness-client-ui-tasks')})
  await page.evaluate(legacy=>{
    window.__legacyTasks=legacy;
    const plugin=__registrations['@xlang/xharness-client-ui-tasks'].factory(id=>{if(id in staticModules)return staticModules[id];throw Error('unexpected Tasks dependency '+id)})
    window.api=plugin;const slots=[];window.cleanup=[]
    plugin.apply({get:name=>name==='workCatalog'?workCatalog:undefined,effect:run=>{const dispose=run();if(typeof dispose==='function')cleanup.push(dispose)},locale:{register:()=>{}},slots:{inject:(_name,run)=>run(),register:(spec,component)=>slots.push({spec,component})}})
    if(slots[0].spec.name!==(window.__legacyTasks?'sidebar.footer.action':'work.center.tasks')||slots[1].spec.id!=='archived-chats')throw Error('archive entry moved or missing')
    window.root=ReactDOM.createRoot(document.getElementById('root'))
    root.render(React.createElement(React.Fragment,null,...slots.map(({component},index)=>React.createElement(component,{key:index,openSession:id=>window.__opened=id}))))
  },process.env.UI_TEST_IMPL==='legacy')
  const rows=()=>page.locator('.xhtask-archived-item')
  await page.waitForFunction(()=>document.querySelectorAll('.xhtask-archived-item').length===4)
  assert.equal(await page.locator('.xhtask-archive-trash svg').count(),4,'original platform trash glyph remains visible')
  assert.equal(await page.locator('.xhtask-settings-group-name').allTextContents().then(x=>JSON.stringify(x)),JSON.stringify(['Alpha','Beta','Other chats']))
  await page.evaluate(()=>document.fonts.ready);const initialPixelsSha256=createHash('sha256').update(await page.locator('#root').screenshot({animations:'disabled'})).digest('hex')
  if(process.env.UI_TEST_IMPL!=='legacy'){
    await page.locator('.xhtask-row').filter({hasText:'Live chat'}).locator('.xhtask-time').click()
    await page.getByRole('button',{name:'Rename',exact:true}).click()
    await page.locator('.xhtask-rename').fill('Requested title')
    await page.locator('.xhtask-rename').press('Enter')
    await assertEventually(()=>renameStarted,'rename must reach the actual typed API')
    await page.evaluate(()=>workManagers.sessions.handleMuxEnvelope({rpcId:'newer-title',payload:{type:'session/projection',sessionId:'live',key:'title',seq:10,value:'Newer owner title'}}))
    await page.waitForFunction(()=>api.store.sessions.find(row=>row.sessionId==='live')?.projections?.values?.title==='Newer owner title')
    releaseRename()
    await page.getByRole('button',{name:'Newer owner title',exact:true}).waitFor()
    assert.equal(await page.getByRole('button',{name:'Requested title',exact:true}).count(),0,'late command acknowledgement and stale list baseline cannot overwrite a newer owner projection')
    assert.equal(requests.some(row=>row.method==='session.history'),false,'Tasks commands read metadata, never chat bodies')
  }
  const search=page.getByRole('searchbox',{name:'Search archived chats'})
  await search.fill('BETA');assert.equal(await rows().count(),2)
  await page.getByRole('combobox',{name:'All chats',exact:true}).selectOption('oldest')
  assert.deepEqual(await page.locator('.xhtask-archive-title').allTextContents(),['Beta child','Beta parent'])
  await search.fill('');await page.getByRole('combobox',{name:'All projects'}).selectOption('a')
  assert.equal(await rows().count(),1)
  await rows().getByRole('button',{name:'Restore',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.xhtask-archived-item').length===0)
  assert.equal(live.some(row=>row.sessionId==='alpha'),true,'restore keeps original identity')
  assert.equal(requests.some(row=>row.method==='session.fork'),false,'restore must never fork')
  await page.getByRole('combobox',{name:'All projects'}).selectOption('b')
  await page.getByRole('combobox',{name:'All chats',exact:true}).selectOption('newest')
  await page.getByRole('button',{name:'Beta · All chats'}).click()
  await page.getByRole('button',{name:'Delete archived chats in this project',exact:true}).click()
  const groupConfirm=page.getByRole('alertdialog',{name:'Delete archived chats in this project'})
  await groupConfirm.waitFor();assert.equal(requests.some(row=>row.method==='session.delete'),false,'opening confirmation is inert')
  await groupConfirm.getByRole('button',{name:'Cancel',exact:true}).click()
  assert.equal(await groupConfirm.count(),0)
  await page.getByRole('button',{name:'Beta · All chats'}).click()
  await page.getByRole('button',{name:'Delete archived chats in this project',exact:true}).click()
  await groupConfirm.getByRole('button',{name:'Delete archived chats in this project',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.xhtask-archived-item').length===0)
  assert.deepEqual(requests.filter(row=>row.method==='session.delete').map(row=>row.payload.sessionId),['beta-parent','beta-child','beta-parent'],'retry parent only after child deletion progress')
  await page.getByRole('combobox',{name:'All projects'}).selectOption('')
  await rows().filter({hasText:'Loose archived chat'}).getByRole('button',{name:'Delete permanently：Loose archived chat'}).click()
  const oneConfirm=page.getByRole('alertdialog',{name:'Delete permanently'})
  await oneConfirm.getByRole('button',{name:'Delete permanently',exact:true}).click()
  await page.locator('.xhtask-settings-root').getByRole('alert').filter({hasText:'host rejects deletion'}).waitFor()
  assert.equal(await rows().filter({hasText:'Loose archived chat'}).count(),1,'failed deletion retains metadata and row')
  denyOrphan=false
  await oneConfirm.getByRole('button',{name:'Delete permanently',exact:true}).click()
  await page.getByText('No archived sessions.',{exact:true}).waitFor()
  if(process.env.UI_TEST_IMPL==='legacy'){
    await page.locator('.xhtask-trigger').click();await page.locator('.xhtask-panel').waitFor();
    await page.keyboard.press('Escape');await page.locator('.xhtask-panel-wrap').waitFor({state:'detached'})
  }else{
    assert.equal(await page.locator('.xhtask-trigger,.xhtask-scrim,.xhtask-panel-wrap').count(),0,'page has no standalone entry/drawer');
    assert.equal(await page.locator('.xhtask-panel').count(),1,'task content is rendered in its page slot');
  }
  assert.equal(await page.locator('.xhtask-archived-toggle').count(),0,'old archive panel stays removed')
  assert.equal(await page.getByRole('heading',{name:'Archived chats',exact:true}).count(),1,'Settings archive entry survives empty conversation/header')
  if(process.env.UI_TEST_IMPL!=='legacy'){
    archived.set('race-a',{sessionId:'race-a',title:'Race Alpha',updatedAt:now});archived.set('race-b',{sessionId:'race-b',title:'Race Beta',updatedAt:now});
    await page.evaluate(()=>workCatalog.refresh());await page.waitForFunction(()=>document.querySelectorAll('.xhtask-archived-item').length===2)
    freezeNextBaseline=true
    await page.evaluate(()=>{window.oldArchiveBaseline=workCatalog.refresh()})
    await assertEventually(()=>frozenBaselineEntered,'old list must be in flight before deletion')
    await page.getByRole('button',{name:'Delete all',exact:true}).click()
    const allConfirm=page.getByRole('alertdialog',{name:'Delete all'})
    await allConfirm.getByRole('button',{name:'Delete all',exact:true}).click()
    await page.waitForFunction(()=>document.querySelectorAll('.xhtask-archived-item').length===0)
    assert.equal(archived.size,0,'both successful deletes commit without waiting on the stalled old baseline')
    await page.waitForFunction(()=>api.store.busyId===null)
    releaseFrozenBaseline();await page.evaluate(()=>oldArchiveBaseline)
    assert.equal(await rows().count(),0,'late pre-delete baseline must not resurrect removed DOM rows')
    assert.equal(await page.locator('.xhtask-action-error').count(),0)
    archived.set('offline-row',{sessionId:'offline-row',title:'Deleted while feed offline',updatedAt:now})
    await page.evaluate(()=>workCatalog.refresh());await page.waitForFunction(()=>document.querySelectorAll('.xhtask-archived-item').length===1)
    failWorkspaceRefresh=true
    await rows().getByRole('button',{name:'Delete permanently：Deleted while feed offline'}).click()
    await page.getByRole('alertdialog',{name:'Delete permanently'}).getByRole('button',{name:'Delete permanently',exact:true}).click()
    await page.getByText('No archived sessions.',{exact:true}).waitFor()
    await page.waitForFunction(()=>api.store.busyId===null)
    assert.equal(await page.evaluate(()=>api.store.actionError),null,'committed deletion is not misreported as a failed mutation')
    await page.locator('.xhtask-action-error').filter({hasText:'archive baseline offline'}).waitFor()
    failWorkspaceRefresh=false;await page.evaluate(()=>workCatalog.refresh())
  }
  await page.evaluate(()=>{root.unmount();for(const run of cleanup)run()})
  assert.equal(await page.locator('#xharness-tasks-panel-style').count(),0,'single-source stylesheet lifecycle disposes')
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({engine,implementation:process.env.UI_TEST_IMPL??'canonical',actualPlatform:true,initialPixelsSha256,fullArchiveSettings:true,hostMetadata:true,projectSearchSort:true,restoreIdentity:true,confirmationAndFailure:true,parentChildRetry:true,staleDeleteAck:process.env.UI_TEST_IMPL!=='legacy',deletionSurvivesRefreshFailure:process.env.UI_TEST_IMPL!=='legacy',sidebarEntry:true,originalIcons:true,styleCleanup:true,staleRenameAck:process.env.UI_TEST_IMPL!=='legacy',pageErrors:errors}))
}finally{await browser.close()}

async function assertEventually(predicate,message){
  for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20))}
  assert.fail(message)
}
