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
  const errors=[]; page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)});await installOwnedViewPlatform(page,process.env.UI_TEST_IMPL==='legacy'?'legacy':'source')
  const now=1789278451000
  const archived=new Map([
    ['alpha',{sessionId:'alpha',title:'Original Alpha',updatedAt:now+50}],
    ['beta-parent',{sessionId:'beta-parent',title:'Beta parent',updatedAt:now+40}],
    ['beta-child',{sessionId:'beta-child',title:'Beta child',updatedAt:now+30}],
    ['orphan',{sessionId:'orphan',title:'Loose archived chat',updatedAt:now+20}],
  ])
  const workspaces=[{workspaceId:'a',title:'Alpha',sessionIds:['alpha'],path:'/a'}, {workspaceId:'b',title:'Beta',sessionIds:['beta-parent','beta-child'],path:'/b'}]
  const live=[{sessionId:'live',updatedAt:now,projections:{values:{title:'Live chat'}}}]
  const requests=[]; let denyOrphan=true
  await page.route('**/api/*',async route=>{
    const body=route.request().postDataJSON(); const {method,payload}=body;requests.push({method,payload})
    let value=null,error
    if(method==='session.list')value={items:live}
    else if(method==='workspace.list')value={items:workspaces,archivedSessionIds:[...archived.keys()],archivedSessions:[...archived.values()]}
    else if(method==='workspace.unarchiveSession') { const saved=archived.get(payload.sessionId); if(saved){archived.delete(payload.sessionId);live.push({sessionId:saved.sessionId,updatedAt:saved.updatedAt,projections:{values:{title:saved.title}}})} value={archivedSessionIds:[...archived.keys()]} }
    else if(method==='session.delete') {
      if(payload.sessionId==='beta-parent'&&archived.has('beta-child'))error='archived child must be deleted first'
      else if(payload.sessionId==='orphan'&&denyOrphan)error='host rejects deletion'
      else {value={deleted:archived.delete(payload.sessionId)}}
    } else if(method==='workspace.archiveSession') { const index=live.findIndex(row=>row.sessionId===payload.sessionId); const [row]=live.splice(index,1);if(row)archived.set(row.sessionId,{sessionId:row.sessionId,title:row.projections.values.title,updatedAt:row.updatedAt});value={archivedSessionIds:[...archived.keys()]} }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:body.rpcId,result:error?{ok:false,error:{message:error}}:{ok:true,value}})})
  })
  await page.addStyleTag({content:':root{--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-border-l2:#ddd;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-2:#fafafa}body{font:14px system-ui;margin:24px}#root{max-width:1000px}'})
  await page.evaluate(()=>document.body.innerHTML='<div id="root"></div>')
  await page.addScriptTag({content:'window.__registrations={};window.__ModuleLoader__={load:r=>__registrations[r.id]=r}'})
  await page.addScriptTag({content:ownedViewModuleTestInput('@xlang/xharness-client-ui-tasks')})
  await page.evaluate(()=>{
    const plugin=__registrations['@xlang/xharness-client-ui-tasks'].factory(id=>{if(id in staticModules)return staticModules[id];throw Error('unexpected Tasks dependency '+id)})
    window.api=plugin;const slots=[];window.cleanup=[]
    plugin.apply({effect:run=>{const dispose=run();if(typeof dispose==='function')cleanup.push(dispose)},locale:{register:()=>{}},slots:{inject:(_name,run)=>run(),register:(spec,component)=>slots.push({spec,component})}})
    if(slots[0].spec.name!=='sidebar.footer.action'||slots[1].spec.id!=='archived-chats')throw Error('archive entry moved or missing')
    window.root=ReactDOM.createRoot(document.getElementById('root'))
    root.render(React.createElement(React.Fragment,null,...slots.map(({component},index)=>React.createElement(component,{key:index}))))
  })
  const rows=()=>page.locator('.xhtask-archived-item')
  await page.waitForFunction(()=>document.querySelectorAll('.xhtask-archived-item').length===4)
  assert.equal(await page.locator('.xhtask-archive-trash svg').count(),4,'original platform trash glyph remains visible')
  assert.equal(await page.locator('.xhtask-settings-group-name').allTextContents().then(x=>JSON.stringify(x)),JSON.stringify(['Alpha','Beta','Other chats']))
  await page.evaluate(()=>document.fonts.ready);const initialPixelsSha256=createHash('sha256').update(await page.locator('#root').screenshot({animations:'disabled'})).digest('hex')
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
  await page.getByRole('alert').filter({hasText:'host rejects deletion'}).waitFor()
  assert.equal(await rows().filter({hasText:'Loose archived chat'}).count(),1,'failed deletion retains metadata and row')
  denyOrphan=false
  await oneConfirm.getByRole('button',{name:'Delete permanently',exact:true}).click()
  await page.getByText('No archived sessions.',{exact:true}).waitFor()
  await page.locator('.xhtask-trigger').click();await page.locator('.xhtask-panel').waitFor()
  assert.equal(await page.locator('.xhtask-archived-toggle').count(),0,'old archive panel stays removed')
  await page.keyboard.press('Escape');await page.locator('.xhtask-panel-wrap').waitFor({state:'detached'})
  assert.equal(await page.getByRole('heading',{name:'Archived chats',exact:true}).count(),1,'Settings archive entry survives empty conversation/header')
  await page.evaluate(()=>{root.unmount();for(const run of cleanup)run()})
  assert.equal(await page.locator('#xharness-tasks-panel-style').count(),0,'single-source stylesheet lifecycle disposes')
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({engine,implementation:process.env.UI_TEST_IMPL??'canonical',actualPlatform:true,initialPixelsSha256,fullArchiveSettings:true,hostMetadata:true,projectSearchSort:true,restoreIdentity:true,confirmationAndFailure:true,parentChildRetry:true,sidebarEntry:true,originalIcons:true,styleCleanup:true,pageErrors:errors}))
}finally{await browser.close()}
