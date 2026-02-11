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
 page.on('pageerror',error=>console.error(error));
 page.setDefaultTimeout(10000);
 await page.setContent('<html><head></head><body><div id="root" style="position:fixed;bottom:16px;right:24px;max-width:calc(100vw - 48px)"></div></body></html>')
 for(const file of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','node_modules',file)})
 await page.addScriptTag({content:'window.__ModuleLoader__={load:x=>{window.registration=x}}'})
 await page.addScriptTag({content:readFileSync(new URL('../ui/dist/plugins/@deepseek-ai/dsh-client-ui-model-selection/client.js',import.meta.url),'utf8')})
 await page.evaluate(async()=>{
  const makeStore=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},update:fn=>{value=structuredClone(value);fn(value);listeners.forEach(fn=>fn())}}}
  const api=registration.factory(id=>{
   if(id==='react')return React;
   if(id==='react/jsx-runtime')return {jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key}),Fragment:React.Fragment};
   if(id==='@deepseek-ai/dsh-client-ui-primitives')return new Proxy({}, {get:(_,key)=>key==='Toast'?({text})=>React.createElement('div',{role:'alert'},text):()=>null});
   if(id==='@deepseek-ai/cordis')return {Service:class{}};
   if(id==='@deepseek-ai/dsh-client-runtime/client')return {createSnapshotStore:makeStore};
   return {};
  });
  window.saved={provider:'p',model:'large',reasoningEffort:'max',contextWindowTokens:65536};window.calls=[];window.offline=false;
  const groups=[{id:'p',models:[{id:'large',name:'Large',contextWindow:131072,contextWindowSource:'provider_reported',reasoning:{defaultEffort:'high',efforts:[{id:'high',name:'高'},{id:'max',name:'极高'}]}},{id:'small',name:'Small',contextWindow:32768},{id:'unknown',name:'Unknown'}]}];
  const sessions={models:async()=>{if(offline)throw Error('offline');return {result:{ok:true,value:{current:saved,groups,failures:[],routable:true}}}},selectModel:async payload=>{if(offline)throw Error('offline');calls.push(payload);saved={...payload};delete saved.sessionId;return {result:{ok:true,value:{selected:saved}}}}};
  window.root=ReactDOM.createRoot(document.getElementById('root'));
  window.mount=async()=>{window.directory=new api.ModelDirectory(sessions,'test',()=>true);await directory.load();root.render(React.createElement(api.XHarnessModelSelect,{t:(key,args)=>({'trigger.aria':'选择模型 '+args?.model,'trigger.ariaEffort':'选择模型 '+args?.model,'menu.model':'模型','menu.effort':'思考强度','menu.aria':'模型设置'}[key]??key),locked:false,available:true,directory:directory.store,load:()=>directory.load().catch(()=>{}),select:s=>directory.select(s).then(()=>true,()=>false)}))};
  await mount();
 })

 const trigger=()=>page.getByRole('button',{name:/^选择模型/});
 const openMenu=async()=>{if(await trigger().getAttribute('aria-expanded')!=='true')await trigger().click()};
 const openContext=async()=>{await openMenu();await page.getByRole('menuitem',{name:/上下文容量/}).click();await page.getByRole('textbox',{name:'上下文 Token 数量'}).waitFor()};
 const closeAll=async()=>{await page.keyboard.press('Escape');await page.keyboard.press('Escape')};
 assert.equal(await page.getByRole('button').count(),1,'composer must have only the upstream model trigger');
 assert.equal(await page.getByRole('button',{name:/^(思考：|上下文：)/}).count(),0,'no duplicate first-level controls');
 await openContext();assert.equal(await page.getByRole('textbox').inputValue(),'65536');
 await page.getByRole('textbox').fill('131073');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>calls.length),0);
 await page.getByRole('textbox').fill('32768');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>saved.contextWindowTokens===32768);assert.equal(await page.evaluate(()=>saved.reasoningEffort),'max');
 await closeAll();await openMenu();await page.getByRole('menuitem',{name:/思考强度/}).click();
 await page.getByRole('menuitemradio',{name:'高',exact:true}).click();
 await page.waitForFunction(()=>saved.reasoningEffort==='high');assert.equal(await page.evaluate(()=>saved.contextWindowTokens),32768,'upstream effort selection must preserve context');
 await page.evaluate(async()=>{directory.dispose();root.unmount();root=ReactDOM.createRoot(document.getElementById('root'));await mount()});
 await openContext();assert.equal(await page.getByRole('textbox').inputValue(),'32768');
 await page.getByRole('textbox').fill('1000');await page.getByRole('button',{name:'← 返回模型设置'}).click();
 await page.getByRole('menuitem',{name:/上下文容量/}).click();assert.equal(await page.getByRole('textbox').inputValue(),'32768');
 await page.getByRole('textbox').fill('1000');await closeAll();assert.equal(await page.evaluate(()=>saved.contextWindowTokens),32768);
 await openContext();assert.equal(await page.getByRole('textbox').inputValue(),'32768');
 await page.getByRole('textbox').fill('2000');await page.mouse.click(10,10);
 await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>saved.contextWindowTokens),32768);
 await openContext();
 // External switch while editing discards the stale form and changes capabilities.
 await page.evaluate(async()=>{saved={provider:'p',model:'small',contextWindowTokens:32768};await directory.load()});
 await page.getByRole('dialog').waitFor({state:'detached'});
 assert.equal(await page.getByRole('menuitem',{name:/思考强度/}).count(),0);
 await openContext();await page.getByRole('textbox').fill('65536');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('alert').waitFor();
 assert.equal(await page.evaluate(()=>saved.model),'small');
 await page.getByRole('button',{name:'填入上限'}).click();assert.equal(await page.getByRole('textbox').inputValue(),'32768');
 await page.evaluate(()=>{offline=true});await page.getByRole('textbox').fill('16384');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'offline'}).waitFor();assert.equal(await page.evaluate(()=>saved.contextWindowTokens),32768);
 await page.evaluate(()=>{offline=false});await page.getByRole('button',{name:'重新获取'}).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>saved.contextWindowTokens===16384);
 await closeAll();
 for(const width of [900,520]) {
  await page.setViewportSize({width,height:620});await openContext();
  const box=await page.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=620,JSON.stringify(box));
  await closeAll();
 }
 await page.evaluate(async()=>{saved={provider:'p',model:'unknown'};await directory.load()});
 await openContext();assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
 await page.getByText('当前模型未提供上限，暂时无法调整。').waitFor();
 await closeAll();await openMenu();await page.getByRole('menuitem',{name:/^模型/}).click();
 await page.getByRole('menuitemradio',{name:'Small',exact:true}).click();
 await page.waitForFunction(()=>saved.model==='small');assert.equal(await page.evaluate(()=>saved.contextWindowTokens),undefined,'new model must not inherit old soft context');
 await openContext();assert.equal(await page.getByRole('textbox').inputValue(),'32768');await closeAll();
 console.log(`${engine}: nested upstream model menu, no duplicate triggers, save/reload, effort preservation, switch, validation, unknown capability, back/Escape/retry and layout passed`);
} finally {await browser.close()}
