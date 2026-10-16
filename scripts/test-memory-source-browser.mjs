// Real headless browser + shipped UI, scripted RPC. Not a model/platform eval.
import assert from 'node:assert/strict'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {mkdirSync} from 'node:fs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
const deps=resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require=createRequire(resolve(deps,'package.json')), engine=process.env.UI_TEST_BROWSER??'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const browser=await require('playwright')[engine].launch({headless:true})
try {
 const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[]
 page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewPlatform(page,'source');await page.evaluate(()=>document.body.innerHTML='<div id="root"></div>')
 await page.addScriptTag({content:`window.__ModuleLoader__={load({factory}){window.memory=factory(name=>{if(name==='react')return React;throw Error(name)})}};`})
 await page.addScriptTag({content:ownedViewModuleTestInput('@xlang/xharness-client-ui-memory')})
 await page.evaluate(()=>{
  window.calls=[]; window.failSave=false;window.failList=false;window.language='en';window.cleanup=[]
  window.docs={global:{available:true,mode:'manual',settingsVersion:null,version:'g1',content:'global note',tooLarge:false,invalidUtf8:false},a:{available:true,mode:'manual',settingsVersion:null,version:'a1',content:'note a',tooLarge:false,invalidUtf8:false},b:{available:true,mode:'manual',settingsVersion:null,version:'b1',content:'note b',tooLarge:false,invalidUtf8:false}}
  const rpc={call:async(channel,endpoint,payload,signal)=>{
   calls.push({channel,endpoint,payload});if(signal.aborted)throw Error('aborted')
   if(endpoint==='workspace.list'&&failList)throw Error('workspace list unavailable')
   if(endpoint==='workspace.list')return{ok:true,value:{items:[{workspaceId:'a',title:'Alpha',path:'/a'},{workspaceId:'b',title:'Beta',path:'/b'}]}}
   if(endpoint!=='workspace/memory')throw Error(endpoint)
   const doc=docs[payload.scope==='global'?'global':payload.workspaceId]
   if(payload.action==='view'){await new Promise(resolve=>setTimeout(resolve,payload.workspaceId==='b'?80:20));return{ok:true,value:{...doc}}}
   if(failSave)return{ok:false,error:{message:'memory changed; reload before saving'}}
   const version=`${doc.version}-next`
   if(payload.action==='configure'){doc.mode=payload.mode;doc.settingsVersion=version}
   else {doc.content=payload.action==='clear'?'':payload.content;doc.version=version}
   return{ok:true,value:{saved:true,version}}
  }}
  let labels,section
  const ctx={effect:fn=>{const dispose=fn();if(typeof dispose==='function')cleanup.push(dispose)},locale:{register:(_ns,value)=>labels=value,bind:()=>key=>labels[language][key]},get:()=>({rpc}),slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>section={spec,component}}}
  memory.apply(ctx);window.mount=ReactDOM.createRoot(document.getElementById('root'));window.render=()=>mount.render(React.createElement(section.component,section.spec.inject()));render()
 })
 const root=page.locator('.xhm-root'),text=root.getByRole('textbox'),workspace=root.getByLabel('Workspace',{exact:true}),mode=root.getByLabel('Memory mode',{exact:true})
 await text.waitFor();await root.getByRole('button',{name:'Reload',exact:true}).waitFor();assert.equal(await text.inputValue(),'global note')
 assert.equal(await root.getByRole('tab',{name:'Global memory',exact:true}).getAttribute('aria-selected'),'true')
 assert.equal(await workspace.count(),0)
 if(process.env.MEMORY_SCREENSHOT){mkdirSync(resolve(process.env.MEMORY_SCREENSHOT,'..'),{recursive:true});await root.screenshot({path:process.env.MEMORY_SCREENSHOT})}
 await text.fill('global draft')
 await root.getByRole('tab',{name:'Workspace memory',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('textarea')?.value==='note a')
 await text.fill('draft a');await workspace.selectOption('b');await workspace.selectOption('a');assert.equal(await text.inputValue(),'draft a')
 await workspace.selectOption('b');await page.waitForFunction(()=>document.querySelector('textarea')?.value==='note b');await workspace.selectOption('a');assert.equal(await text.inputValue(),'draft a')
 await root.getByRole('tab',{name:'Global memory',exact:true}).click();assert.equal(await text.inputValue(),'global draft')
 await root.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>docs.global.content==='global draft')
 await root.getByRole('tab',{name:'Workspace memory',exact:true}).click();assert.equal(await text.inputValue(),'draft a')
 await page.evaluate(()=>failSave=true);await root.getByRole('button',{name:'Save',exact:true}).click();await root.getByRole('alert').getByText(/draft is preserved/).waitFor();assert.equal(await text.inputValue(),'draft a')
 await page.evaluate(()=>failSave=false)
 page.once('dialog',d=>d.dismiss());await root.getByRole('button',{name:'Reload',exact:true}).click();assert.equal(await text.inputValue(),'draft a')
 page.once('dialog',d=>d.accept());await root.getByRole('button',{name:'Reload',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea')?.value==='note a')
 page.once('dialog',d=>d.dismiss());await mode.selectOption('auto');assert.equal(await mode.inputValue(),'manual')
 page.once('dialog',d=>d.accept());await mode.selectOption('auto');await page.waitForFunction(()=>docs.a.mode==='auto');await root.getByRole('status').getByText('Saved',{exact:true}).waitFor()
 await mode.selectOption('off');await root.getByText(/content already in a running context/).waitFor()
 page.once('dialog',d=>d.dismiss());await root.getByRole('button',{name:'Clear memory',exact:true}).click();assert.equal(await text.inputValue(),'note a')
 page.once('dialog',d=>d.accept());await root.getByRole('button',{name:'Clear memory',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea')?.value==='')
 await page.evaluate(()=>{docs.a={available:false}});await root.getByRole('button',{name:'Reload',exact:true}).click();await root.getByText('Memory is not enabled in this deployment.',{exact:true}).waitFor();assert.equal(await text.count(),0)
 await root.getByRole('tab',{name:'Global memory',exact:true}).click();assert.equal(await text.inputValue(),'global draft');assert.equal(await mode.inputValue(),'manual')
 page.once('dialog',d=>d.accept());await root.getByRole('button',{name:'Clear memory',exact:true}).click();await page.waitForFunction(()=>docs.global.content==='')
 assert.equal(await page.evaluate(()=>docs.b.content),'note b')
 // Global settings must still work without a workspace or a healthy list RPC.
 await page.evaluate(()=>{failList=true;docs.global.content='global without workspace';mount.unmount();mount=ReactDOM.createRoot(document.getElementById('root'));render()})
 await page.waitForFunction(()=>document.querySelector('textarea')?.value==='global without workspace')
 assert.equal(await workspace.count(),0);assert.equal(await root.getByRole('alert').count(),0)
 await text.fill('global edited without workspace');await root.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>docs.global.content==='global edited without workspace')
 await page.evaluate(()=>{language='zh';render()});await root.getByRole('heading',{name:'记忆',exact:true}).waitFor()
 await root.getByRole('tab',{name:'全局记忆',exact:true}).waitFor()
 const calls=await page.evaluate(()=>calls)
 assert.ok(calls.some(c=>c.payload.action==='save'&&c.payload.version==='a1'&&c.payload.content==='draft a'))
 assert.equal(calls.filter(c=>c.payload.action==='configure'&&c.payload.mode==='auto').length,1)
 assert.equal(calls.filter(c=>c.payload.action==='clear'&&c.payload.workspaceId==='a').length,1)
 assert.equal(calls.filter(c=>c.payload.action==='clear'&&c.payload.scope==='global').length,1)
 assert.ok(calls.filter(c=>c.payload.scope==='global').every(c=>!('workspaceId' in c.payload)&&!('sessionId' in c.payload)))
 assert.ok(calls.every(c=>c.channel==='/api'&&!('cwd'in c.payload)&&!('path'in c.payload)))
 await page.evaluate(()=>{mount.unmount();for(const fn of cleanup)fn()});assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,implementation:process.env.UI_TEST_IMPL??'canonical',scriptedRpc:true,globalWithoutWorkspace:true,scopeIsolation:true,globalDefaultPage:true,draftSurvivesSwitchAndConflict:true,lateWorkspaceResponseIsScoped:true,versionCas:true,autoAndClearConfirm:true,off:true,unavailable:true,bilingual:true,pageErrors:errors}))
} finally {await browser.close()}
