/** Real shipped Import React component; API fixture only. Rust acceptance owns parsing/storage. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await require('playwright')[engine].launch({headless:true})
try{
 for(const lang of ['zh','en']){
  const page=await browser.newPage({viewport:{width:800,height:780}});const errors=[]
  page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
  await installOwnedViewPlatform(page,'source')
  await page.evaluate(()=>{window.registration=null;window.__ModuleLoader__={load:r=>{window.registration=r}}})
  await page.addScriptTag({content:readFileSync(resolve('ui/dist/plugins/@xlang/xharness-client-ui-session-import/client.js'),'utf8')})
  await page.evaluate(lang=>{
   const React=staticModules.react,ReactDOM=staticModules['react-dom'];window.calls=[];window.opened=[];window.closedCount=0;window.failPreview=false
   const api={sessions:{importHistory:async(payload,signal)=>{calls.push({payload,aborted:signal?.aborted});if(failPreview){failPreview=false;return{result:{ok:false,error:{message:'network unavailable'}}}}return{result:{ok:true,value:{...(!payload.preview?{sessionId:'import-fixture'}:{}),title:'Imported task',messages:3,tools:1,warnings:['unfinished-tools-recorded-only'],preview:[{role:'user',content:'fix the test'},{role:'assistant',content:'[Historical tool call: Read; record only]'}]}}}}}}
   const sessions={refresh:async()=>{},open:id=>opened.push(id)};let labels,Component,props
   const ctx={effect:fn=>fn(),get:()=>({api}),sessions,locale:{register:(_,dict)=>{labels=dict[lang]},bind:()=> (key,values={})=>{let text=labels[key]??key;for(const[k,v]of Object.entries(values))text=text.replaceAll('{'+k+'}',String(v));return text}},slots:{inject:(_,fn)=>fn(),register:(spec,C)=>{Component=C;props=spec.inject()}}}
   registration.factory(id=>staticModules[id]).apply(ctx)
   window.root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(Component,{...props,close:()=>{closedCount++}}))
  },lang)
  const zh=lang==='zh',file=page.getByLabel(zh?'会话文件':'Session file'),submit=page.getByRole('button',{name:zh?'导入并打开':'Import & open'})
  await submit.waitFor();assert.equal(await submit.isDisabled(),true)
  await file.setInputFiles({name:'source.jsonl.zst',mimeType:'application/octet-stream',buffer:Buffer.from('compressed')})
  await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>calls.length),0)
  await page.evaluate(()=>{failPreview=true})
  await file.setInputFiles({name:'source.jsonl',mimeType:'application/json',buffer:Buffer.from('{"type":"session_meta"}\n')})
  await page.getByRole('alert').waitFor();assert.equal(await submit.isDisabled(),true)
  await page.getByRole('button',{name:zh?'重试预览':'Retry preview'}).click()
  await page.getByText('Imported task',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>calls.every(c=>c.payload.preview)),true)
  await page.getByText(zh?'存在结果未知的旧工具调用，仅保留记录。':'Some old tool calls have unknown results; records only.').waitFor()
  await page.getByText(zh?'查看内容预览':'Preview content',{exact:true}).click();await page.getByText('user: fix the test',{exact:true}).waitFor()
  await page.getByLabel(zh?'目标工作目录（可选）':'Working directory (optional)').fill('/chosen/workspace')
  await submit.click();await page.waitForFunction(()=>closedCount===1)
  assert.deepEqual(await page.evaluate(()=>opened),['import-fixture'])
  assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.payload.preview)),[true,true,false])
  assert.equal(await page.evaluate(()=>calls.at(-1).payload.cwd),'/chosen/workspace')
  await page.getByLabel(zh?'来源':'Source').selectOption('codex');assert.equal(await submit.isDisabled(),true)
  await page.getByText('~/.codex/sessions/',{exact:false}).waitFor()
  assert.deepEqual(errors,[])
  await page.close()
 }
 console.log(`Session import UI: ${engine}, zh/en, explicit preview/commit, retry, source reset and compressed-file rejection passed (API fixture only)`)
}finally{await browser.close()}
