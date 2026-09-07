// Isolated browser regression of the shipped component + ModelDirectory; no user sessions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','package.json'))
const {chromium,webkit}=require('playwright')
const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await ({chromium,webkit}[engine]).launch({headless:true})
try {
 const page=await browser.newPage({viewport:{width:900,height:620}})
 await page.setContent('<html><head></head><body><div id="root" style="position:fixed;bottom:16px;right:24px;max-width:calc(100vw - 48px)"></div></body></html>')
 for(const file of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','node_modules',file)})
 await page.addScriptTag({content:'window.__ModuleLoader__={load:x=>{window.registration=x}}'})
 await page.addScriptTag({content:readFileSync(new URL('../ui/dist/plugins/@deepseek-ai/dsh-client-ui-model-selection/client.js',import.meta.url),'utf8')})
 await page.evaluate(async()=>{
  const makeStore=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},update:fn=>{value=structuredClone(value);fn(value);listeners.forEach(fn=>fn())}}}
  const api=registration.factory(id=>{
   if(id==='react')return React;
   if(id==='@deepseek-ai/cordis')return {Service:class{}};
   if(id==='@deepseek-ai/dsh-client-runtime/client')return {createSnapshotStore:makeStore};
   return {};
  });
  window.saved={provider:'p',model:'large',reasoningEffort:'max',contextWindowTokens:65536};window.calls=[];window.offline=false;
  const groups=[{id:'p',models:[{id:'large',contextWindow:131072,contextWindowSource:'provider_reported',reasoning:{defaultEffort:'high',efforts:[{id:'high',name:'高'},{id:'max',name:'极高'}]}},{id:'small',contextWindow:32768},{id:'unknown'}]}];
  const sessions={models:async()=>{if(offline)throw Error('offline');return {result:{ok:true,value:{current:saved,groups,failures:[],routable:true}}}},selectModel:async payload=>{if(offline)throw Error('offline');calls.push(payload);saved={...payload};delete saved.sessionId;return {result:{ok:true,value:{selected:saved}}}}};
  window.root=ReactDOM.createRoot(document.getElementById('root'));
  window.mount=async()=>{window.directory=new api.ModelDirectory(sessions,'test',()=>true);await directory.load();root.render(React.createElement(api.XHarnessModelControls,{locked:false,available:true,directory:directory.store,load:()=>directory.load().catch(()=>{}),select:s=>directory.select(s).then(()=>true,()=>false)}))};
  await mount();
 })
 await page.getByRole('button',{name:'上下文：64K',exact:true}).click()
 await page.getByRole('textbox',{name:'上下文 Token 数量'}).fill('131073')
 await page.getByRole('button',{name:'保存',exact:true}).click()
 await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>calls.length),0)
 await page.getByRole('textbox').fill('32768');await page.getByRole('button',{name:'保存',exact:true}).click()
 await page.getByRole('button',{name:'上下文：32K',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>saved.reasoningEffort),'max')
 await page.getByRole('button',{name:'思考：极高',exact:true}).click()
 await page.getByRole('button',{name:'高',exact:true}).click()
 await page.getByRole('button',{name:'思考：高',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>saved.contextWindowTokens),32768)
 // Recreate the UI directory from persisted server state (not localStorage).
 await page.evaluate(async()=>{root.unmount();root=ReactDOM.createRoot(document.getElementById('root'));await mount()})
 await page.getByRole('button',{name:'上下文：32K',exact:true}).waitFor()
 await page.getByRole('button',{name:'思考：高',exact:true}).waitFor()
 // Dismiss an unsaved draft, then reopen; no accidental write.
 await page.getByRole('button',{name:'上下文：32K',exact:true}).click()
 await page.getByRole('textbox').fill('1000');await page.keyboard.press('Escape')
 assert.equal(await page.evaluate(()=>saved.contextWindowTokens),32768)
 await page.getByRole('button',{name:'上下文：32K',exact:true}).click()
 assert.equal(await page.getByRole('textbox').inputValue(),'32768')
 // External model switch invalidates an open larger-model draft, updates limits and removes unsupported effort.
 await page.evaluate(async()=>{saved={provider:'p',model:'small',contextWindowTokens:32768};await directory.load()})
 await page.getByRole('dialog').waitFor({state:'detached'})
 assert.equal(await page.getByRole('button',{name:'思考：未声明'}).isDisabled(),true)
 await page.getByRole('button',{name:'上下文：32K',exact:true}).click()
 await page.getByRole('textbox').fill('65536');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>saved.model),'small')
 await page.getByRole('button',{name:'填入上限'}).click();assert.equal(await page.getByRole('textbox').inputValue(),'32768')
 // Explicit transport failure must keep old saved value and offer a retry.
 await page.evaluate(()=>{offline=true});await page.getByRole('textbox').fill('16384');await page.getByRole('button',{name:'保存',exact:true}).click()
 await page.getByRole('alert').filter({hasText:'offline'}).waitFor();assert.equal(await page.evaluate(()=>saved.contextWindowTokens),32768)
 await page.evaluate(()=>{offline=false});await page.getByRole('button',{name:'重新获取'}).click()
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'上下文：16K'}).waitFor()
 for(const width of [900,520]) {
  await page.setViewportSize({width,height:620});await page.getByRole('button',{name:'上下文：16K'}).click()
  const box=await page.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=620,JSON.stringify(box))
  await page.getByRole('button',{name:'关闭',exact:true}).click()
 }
 await page.evaluate(async()=>{saved={provider:'p',model:'unknown'};await directory.load()})
 assert.equal(await page.getByRole('button',{name:'上下文：未知'}).isDisabled(),true)
 console.log(`${engine}: model controls save/reload, effort preservation, switch, validation, unknown capability, dismiss/retry and viewport tests passed`)
} finally {await browser.close()}
