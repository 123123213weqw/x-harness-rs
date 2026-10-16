/** Real React + shared panels, isolated RPC fixture: no personal sessions or models. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
const require=createRequire(resolve('ui/package.json')),{buildSync}=require('esbuild')
const browserRequire=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium',browser=await browserRequire('playwright')[engine].launch({headless:true})
const evidence=resolve('docs/evidence/unified-jobs-20261013');mkdirSync(evidence,{recursive:true})
const ui=buildSync({stdin:{contents:"export {JobClient} from './ui/src/modules/jobs/client';export {JobRunPanel,JobToolPanel} from './ui/src/modules/jobs/RunPanel';export {WorkCenter} from './ui/src/modules/layout/WorkCenter'",resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'browser',external:['react'],loader:{'.css':'text'}}).outputFiles[0].text
try {
 const page=await browser.newPage({viewport:{width:1040,height:780}}),errors=[]
 page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewHtml(page,'source','<html lang="zh-CN"><head></head><body><div id="root"></div></body></html>')
 await page.addScriptTag({content:`window.JobFixture={exports:{}};(function(module,exports,require){${ui}\n})(JobFixture,JobFixture.exports,id=>staticModules[id]);`})
 await page.evaluate(()=>{
  const {JobClient,JobRunPanel}=JobFixture.exports
  window.calls=[];window.opens=[];window.mode='running';window.planState='scheduled'
  window.catalog=()=>({version:1,sessionId:'a',plans:[{id:'p',label:'定时检查',state:planState,nextAt:'2026-10-13T00:00:00Z',everySeconds:300}],runs:[
   {id:'bash-generation-1',label:'后台编译 <script>not executable</script>',sourceSessionId:'a',targetSessionId:'a',planId:null,state:mode,reference:{kind:'process',id:'bash-generation-1'},capabilities:{cancelRun:mode==='running',readOutput:true,openSession:false},startedAtMs:1,scheduledAtMs:null,finishedAtMs:null,detail:null},
   {id:'schedule:a:p:one',label:'Agent 检查',sourceSessionId:'a',targetSessionId:'child',planId:'p',state:'running',reference:{kind:'automation',planId:'p',inputId:'schedule:a:p:one'},capabilities:{cancelRun:false,readOutput:false,openSession:true},startedAtMs:null,scheduledAtMs:1,finishedAtMs:null,detail:null}]})
  window.rpc={async call(path,name,payload){calls.push({path,name,payload});const c=payload.command
   if(c.action==='list')return {ok:true,value:catalog()}
   if(c.action==='cancel_run')mode='stopping'
   if(c.action==='pause_plan')planState='paused'
   if(c.action==='resume_plan')planState='scheduled'
   if(c.action==='cancel_future')planState='deleted'
   if(c.action==='output')return {ok:true,value:{version:1,stdout:'输出 <img src=x onerror=alert(1)>',stderr:'',stdoutTruncated:false,stderrTruncated:false,nextCursor:{job_id:'bash-generation-1',stdout:10,stderr:0},run:catalog().runs[0]}}
   return {ok:true,value:{version:1,accepted:true}}
  }}
  window.client=new JobClient(rpc);window.root=ReactDOM.createRoot(document.getElementById('root'))
  root.render(React.createElement(JobRunPanel,{client,sessionId:'a',openSession:id=>opens.push(id)}))
 })
 const process=page.locator('[data-run-id="bash-generation-1"]'),agent=page.locator('[data-run-id="schedule:a:p:one"]')
 await process.waitFor();await agent.waitFor();assert.equal(await agent.getByRole('button',{name:'取消本次执行'}).count(),0)
 await agent.getByRole('button',{name:'查看对话'}).click();assert.deepEqual(await page.evaluate(()=>opens),['child'])
 await process.getByRole('button',{name:'读取输出'}).click();await page.getByRole('region',{name:'执行记录'}).getByText('输出 <img src=x onerror=alert(1)>',{exact:true}).waitFor();assert.equal(await page.locator('[onerror],pre img,pre script').count(),0)
 await process.getByRole('button',{name:'取消本次执行'}).click();await process.getByText('命令 · 停止中',{exact:true}).waitFor();assert.equal(await process.getByText('命令 · 已完成',{exact:true}).count(),0)
 await page.getByRole('button',{name:'暂停未来触发'}).evaluate(b=>{b.click();b.click()});await page.getByText('计划 · 未来触发已暂停',{exact:true}).waitFor();assert.equal(await agent.getAttribute('data-run-state'),'running')
 await page.getByRole('button',{name:'取消未来触发'}).click();await page.getByRole('button',{name:'确认',exact:true}).click();await page.getByText('计划 · 未来触发已取消',{exact:true}).waitFor();assert.equal(await agent.getAttribute('data-run-state'),'running')
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.payload.command.action==='pause_plan').length),1)
 for(const theme of ['light','dark']) {
  await page.evaluate(theme=>{document.body.style.setProperty('--dsw-alias-background-primary',theme==='dark'?'#202020':'#fff');document.body.style.setProperty('--dsw-alias-label-primary',theme==='dark'?'#eee':'#222');document.body.style.setProperty('--dsw-alias-label-tertiary',theme==='dark'?'#aaa':'#666');document.body.style.setProperty('--dsw-alias-border-l1',theme==='dark'?'#444':'#ddd');document.body.style.background=theme==='dark'?'#121212':'#f7f7f7';document.documentElement.style.background=document.body.style.background;document.getElementById('root').style.background='transparent';document.getElementById('root').style.minHeight='100vh'},theme)
  await page.screenshot({path:resolve(evidence,`jobs-${engine}-${theme}.png`),fullPage:true})
 }
 await page.setViewportSize({width:430,height:780});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve(evidence,`jobs-${engine}-mobile.png`),fullPage:true});await page.setViewportSize({width:1040,height:780})
 // A targeted process card must not display unrelated plans or Agent runs.
 await page.evaluate(()=>{const {JobToolPanel}=JobFixture.exports;root.render(React.createElement(JobToolPanel,{client,sessionId:'a',block:{callId:'b',kind:'tool-result',content:[{type:'text',text:JSON.stringify({ok:true,content:JSON.stringify({job_id:'bash-generation-1',status:'completed'})})}]}}))})
 await process.waitFor();assert.equal(await page.getByText('定时检查',{exact:true}).count(),0);assert.equal(await agent.count(),0);assert.equal(await process.getAttribute('data-run-state'),'stopping','historical tool status cannot override execution state')
 // Retired identity must never bind a newer run with a similar counter.
 await page.evaluate(()=>{const {JobToolPanel}=JobFixture.exports;root.render(React.createElement(JobToolPanel,{client,sessionId:'a',block:{argsRaw:'{"job_id":"bash-old-generation-1"}'}}))})
 await page.getByText(/此运行已失效/).waitFor();assert.equal(await process.count(),0)
 // Real three-tab keyboard navigation, no replacement of the chat mount.
 await page.evaluate(()=>{const {WorkCenter}=JobFixture.exports;root.render(React.createElement(WorkCenter,{close(){},renderTasks:()=>React.createElement('p',null,'tasks fixture'),renderAutomations:()=>React.createElement('p',null,'automation fixture'),renderExecutions:()=>React.createElement('p',null,'execution fixture')}))})
 await page.getByRole('tab',{name:'任务',exact:true}).press('End');await page.getByText('execution fixture',{exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'执行',exact:true}).getAttribute('aria-selected'),'true')
 await page.getByRole('tab',{name:'执行',exact:true}).press('ArrowLeft');await page.getByText('automation fixture',{exact:true}).waitFor()
 await page.setViewportSize({width:430,height:780});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await page.evaluate(()=>root.unmount());assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,passed:true,scenarios:['process/agent shared panel','owner API controls','cancel is not completion','cancel future does not stop run','escaped output','light/dark tokens','retired ID','targeted-card scoping','keyboard navigation','mobile width','unmount'],requests:await page.evaluate(()=>calls.length)}))
} finally {await browser.close()}
