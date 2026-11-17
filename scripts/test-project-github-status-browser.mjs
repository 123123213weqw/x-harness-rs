/** Actual production row + React, both CI browser engines. No live Host mutation. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {compileSourceModules} from './build-source-modules.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
const deps=process.env.UI_TEST_DEPS??resolve('scripts/ui-test-deps'),require=createRequire(resolve(deps,'package.json')),{chromium,webkit}=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium'
const id='project-badge-browser',code=compileSourceModules('ui',[{id,source:'src/modules/workspace/test-exports.ts'}]).get(id).bytes.toString()
const browser=await({chromium,webkit}[engine]).launch({headless:true})
try {
 const page=await browser.newPage({viewport:{width:900,height:650}}),errors=[]
 page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewPlatform(page,'source');await page.addScriptTag({content:'window.__ModuleLoader__={load:x=>window.registration=x}'});await page.addScriptTag({content:code})
 await page.evaluate(()=>{
  const api=registration.factory(name=>{if(name==='@xharness/dsh-client-runtime/client')return {defineStore:spec=>({spec}),indexSubagentDescendants:()=>new Map(),abbreviateHomePath:p=>p};if(name in staticModules)return staticModules[name];throw Error(name)})
  document.body.innerHTML='<div id="fixture" style="width:280px;margin:20px"></div>';window.calls=[];window.toggles=0;window.response={kind:'ready',ci:'passing',repository:'alice/project',branch:'feature',localSha:'a'.repeat(40),headSha:'a'.repeat(40),number:7,url:'https://github.com/alice/project/pull/7',state:'OPEN',draft:false,repositoryId:'R_project7'};window.fixtureHidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>fixtureHidden})
  const read=api.projectStatusReader({call:async(...args)=>{calls.push(args);if(window.delay)return await new Promise(done=>{window.resolveOld=done});if(window.fail)return{ok:false,error:{message:'gh auth expired; run gh auth login on Host'}};return{ok:true,value:response}}})
  const t=key=>api.zh[key]??key
  window.feed=new api.ProjectEventFeed()
  window.currentGeneration={home:'/home'}
  let props={generation:currentGeneration,workspaceId:'w',path:'/repo',active:false,expanded:false}
  window.root=ReactDOM.createRoot(document.getElementById('fixture'))
  window.renderBadge=patch=>{props={...props,...patch};root.render(React.createElement(api.ProjectRowItem,{group:{key:props.workspaceId,workspaceId:props.workspaceId,cwd:props.path,label:'Long Project 工作区名称',createdAt:1789192051593,sessionCount:0,expanded:props.expanded,containsCurrent:props.active,sessions:[]},readProjectStatus:read,projectEvents:feed,projectGeneration:props.generation,onToggle:()=>toggles++,onCreate:()=>{},t}))}
  renderBadge({})
  window.signal=(raw,generation=props.generation)=>feed.receive(raw,generation)
 })
 const trigger=page.locator('.xhproject-github-trigger'),panel=page.getByRole('dialog',{name:'GitHub 状态'})
 await page.waitForFunction(()=>document.querySelector('[data-ci=passing]'))
 assert.equal(await page.evaluate(()=>calls.length),1)
 await page.waitForTimeout(1200);assert.equal(await page.evaluate(()=>calls.length),1,'idle time does not cause polling')
 await trigger.click();await panel.waitFor();await page.waitForTimeout(600);assert.equal(await page.getByRole('tooltip').count(),0,'workspace hover card is suppressed while badge details are open');assert.equal(await page.evaluate(()=>toggles),0,'badge click never toggles project')
 assert.equal(await panel.getByRole('link').getAttribute('href'),'https://github.com/alice/project/pull/7')
 await panel.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>calls.length===2);await page.waitForFunction(()=>document.querySelector('[data-ci=passing]'))
 await panel.dispatchEvent('scroll');await panel.waitFor();await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'})
 await page.evaluate(()=>{window.response={...response,ci:'failing'};window.dispatchEvent(new Event('focus'))});await page.waitForFunction(()=>document.querySelector('[data-ci=failing]'))
 await page.evaluate(()=>{window.response={...response,ci:'pending',draft:true};window.dispatchEvent(new Event('focus'))});await page.waitForFunction(()=>document.querySelector('[data-ci=pending]'));assert.equal(await trigger.getAttribute('data-draft'),'true')
 await page.evaluate(()=>{window.response={...response,ci:'outdated',localSha:'b'.repeat(40),state:'MERGED',draft:false};window.dispatchEvent(new Event('focus'))});await page.waitForFunction(()=>document.querySelector('[data-ci=outdated]'));assert.equal(await trigger.getAttribute('data-pr'),'MERGED')
 await trigger.click();assert.ok((await panel.innerText()).includes('bbbbbbbb'));await page.keyboard.press('Escape')
 await page.evaluate(()=>{window.fail=true;window.dispatchEvent(new Event('focus'))});await page.waitForFunction(()=>document.querySelector('.xhproject-github-trigger').getAttribute('aria-label').includes('查询失败'));assert.equal(await page.locator('[data-ci=passing]').count(),0)
 await trigger.click();await panel.getByRole('alert').waitFor();assert.match(await panel.getByRole('alert').innerText(),/gh auth expired/);await page.keyboard.press('Escape')
 for(const kind of ['no_pr','unsupported','ambiguous']){await page.evaluate(kind=>{window.fail=false;window.response={kind,ci:'none'};window.dispatchEvent(new Event('focus'))},kind);await page.waitForFunction(kind=>document.querySelector('.xhproject-github-trigger').getAttribute('aria-label').includes(({no_pr:'此分支未找到 PR',unsupported:'未连接 GitHub 分支',ambiguous:'无法唯一定位 PR'})[kind]),kind);assert.equal(await page.locator('[data-ci=passing]').count(),0)}
 // Resolve an old generation only after the new generation completed.
 await page.evaluate(()=>{window.delay=true;window.dispatchEvent(new Event('focus'))});await page.waitForFunction(()=>window.resolveOld)
 await page.evaluate(()=>{window.delay=false;window.response={...response,kind:'no_pr',ci:'none'};renderBadge({generation:{home:'/remote'},workspaceId:'w2',path:'/remote'})});await page.waitForFunction(()=>calls.at(-1)[2].workspaceId==='w2');await page.waitForFunction(()=>document.querySelector('.xhproject-github-trigger').getAttribute('aria-label').includes('此分支未找到 PR'))
 await page.evaluate(()=>resolveOld({ok:true,value:{kind:'ready',ci:'passing',repository:'alice/project',branch:'feature',localSha:'a'.repeat(40),headSha:'a'.repeat(40),number:999,url:'https://github.com/alice/project/pull/999',state:'OPEN',draft:false}}));await page.waitForTimeout(100);assert.equal(await page.locator('[data-ci=passing]').count(),0,'late old Host never turns new Host green')
 const before=await page.evaluate(()=>calls.length)
 await page.evaluate(()=>{fixtureHidden=true;window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>calls.length),before)
 await page.evaluate(()=>{fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'))});await page.waitForFunction(n=>calls.length===n+1,before)
 const expandBefore=await page.evaluate(()=>calls.length);await page.evaluate(()=>renderBadge({expanded:true}));await page.waitForFunction(n=>calls.length===n+1,expandBefore)
 const focusBefore=await page.evaluate(()=>calls.length);await page.evaluate(()=>renderBadge({active:true}));await page.waitForFunction(n=>calls.length===n+1,focusBefore)
 await page.evaluate(()=>{window.response={kind:'ready',ci:'passing',repository:'alice/project',branch:'feature',localSha:'a'.repeat(40),headSha:'a'.repeat(40),number:7,url:'https://github.com/alice/project/pull/7',state:'OPEN',draft:false,repositoryId:'R_project7'};window.dispatchEvent(new Event('focus'))});await page.waitForFunction(()=>document.querySelector('[data-ci=passing]'))
 for(const width of [220,280,400])for(const dark of [false,true]){
  await page.evaluate(({width,dark})=>{document.getElementById('fixture').style.width=width+'px';document.body.toggleAttribute('data-ds-dark-theme',dark)}, {width,dark})
  const fits=await trigger.evaluate(node=>{const row=node.closest('[role=treeitem]').getBoundingClientRect(),badge=node.getBoundingClientRect();return badge.left>=row.left&&badge.right<=row.right});assert.equal(fits,true,'badge fits narrow project row')
 }
 await page.evaluate(()=>{document.body.removeAttribute('data-ds-dark-theme');document.getElementById('fixture').style.width='280px'})
 const out='dist/project-github-status';mkdirSync(out,{recursive:true});await page.locator('#fixture').screenshot({path:`${out}/${engine}-row.png`});await trigger.click();await panel.waitFor();await page.screenshot({path:`${out}/${engine}-details.png`})
 await page.keyboard.press('Escape')
 const beforeWebhook=await page.evaluate(()=>calls.length)
 await page.evaluate(()=>{response={...response,ci:'failing'};signal({repositoryIds:['R_project7'],reset:false,connected:true})})
 await page.waitForFunction(()=>document.querySelector('[data-ci=failing]'))
 assert.equal(await page.evaluate(()=>calls.length),beforeWebhook+1,'push invalidation refreshes without focus or manual action')
 const beforeWrongRepo=await page.evaluate(()=>calls.length)
 await page.evaluate(()=>signal({repositoryIds:['R_other999'],reset:false,connected:true}))
 await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>calls.length),beforeWrongRepo,'another repository cannot refresh this project')
 await page.evaluate(()=>{response={kind:'no_pr',ci:'none',repositoryId:'R_project7'};signal({repositoryIds:['R_project7'],reset:false,connected:true})})
 await page.waitForFunction(()=>document.querySelector('.xhproject-github-trigger').getAttribute('aria-label').includes('此分支未找到 PR'))
 await page.evaluate(()=>{response={kind:'ready',ci:'pending',repository:'alice/project',branch:'feature',localSha:'a'.repeat(40),headSha:'a'.repeat(40),number:8,url:'https://github.com/alice/project/pull/8',state:'OPEN',draft:false,repositoryId:'R_project7'};signal({repositoryIds:['R_project7'],reset:false,connected:true})})
 await page.waitForFunction(()=>document.querySelector('[data-ci=pending]'))
 await page.evaluate(()=>signal({repositoryIds:[],reset:false,connected:false}))
 await page.waitForFunction(()=>document.querySelector('.xhproject-github-trigger').getAttribute('aria-label').includes('查询失败'))
 assert.equal(await page.locator('[data-ci=passing]').count(),0,'lost live connection cannot leave an old green result')
 await page.evaluate(()=>{response={...response,ci:'passing'};signal({repositoryIds:[],reset:true,connected:true})})
 await page.waitForFunction(()=>document.querySelector('[data-ci=passing]'))
 const hiddenEvents=await page.evaluate(()=>calls.length)
 await page.evaluate(()=>{fixtureHidden=true;response={...response,ci:'failing'};signal({repositoryIds:['R_project7'],reset:false,connected:true})})
 await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>calls.length),hiddenEvents,'hidden row records dirty state without work')
 await page.evaluate(()=>{fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'))})
 await page.waitForFunction(()=>document.querySelector('[data-ci=failing]'))
 const oldGenerationCount=await page.evaluate(()=>calls.length)
 await page.evaluate(()=>signal({repositoryIds:[],reset:true,connected:true},currentGeneration))
 await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>calls.length),oldGenerationCount,'old Host generation cannot invalidate a new Host')
 const burstStart=await page.evaluate(()=>calls.length)
 await page.evaluate(()=>{delay=true;signal({repositoryIds:['R_project7'],reset:false,connected:true})})
 await page.waitForFunction(n=>calls.length===n+1,burstStart)
 await page.evaluate(()=>{for(let i=0;i<100;i++)signal({repositoryIds:['R_project7'],reset:false,connected:true})})
 assert.equal(await page.evaluate(()=>calls.length),burstStart+1,'burst cannot start concurrent gh reads')
 await page.evaluate(()=>{delay=false;response={...response,ci:'pending'};resolveOld({ok:true,value:{...response,ci:'passing'}})})
 await page.waitForFunction(()=>document.querySelector('[data-ci=pending]'))
 assert.equal(await page.evaluate(()=>calls.length),burstStart+2,'one coalesced follow-up observes latest state')
 await page.evaluate(()=>root.unmount());await panel.waitFor({state:'hidden'});const last=await page.evaluate(()=>calls.length);await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));signal({repositoryIds:[],reset:true,connected:true})});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>calls.length),last,'unmount removes all refresh listeners');assert.deepEqual(errors,[])
 const result={engine,actualProductionRow:true,noPolling:true,manualRefresh:true,focusVisibilityRefresh:true,projectOpenRefresh:true,lateHostResponseIgnored:true,unknownNeverGreen:true,narrowAndDarkLayout:true,unmountCleanup:true,webhookAutoRefresh:true,repositoryFiltering:true,noPrToNewPr:true,offlineReconnect:true,hiddenEventCoalescing:true,oldHostSignalIgnored:true,eventBurstCoalesced:true,pageErrors:errors};writeFileSync(`${out}/${engine}.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
} finally {await browser.close()}
