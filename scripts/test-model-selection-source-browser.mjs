// Isolated real Chromium/WebKit source migration acceptance; no user sessions.
import assert from 'node:assert/strict'
import { compileSourceModules } from './build-source-modules.mjs'
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
 await page.addScriptTag({content:process.env.UI_TEST_IMPL === 'legacy' ? readFileSync(new URL('../ui/reference/master-a613970/plugins/@xharness/dsh-client-ui-model-selection/client.js',import.meta.url),'utf8') : process.env.UI_TEST_IMPL === 'canonical' ? readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-model-selection/client.js',import.meta.url),'utf8') : compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id:'@xharness/dsh-client-ui-model-selection',source:'src/modules/model-selection/index.ts'}]).get('@xharness/dsh-client-ui-model-selection').bytes.toString()})
 await page.evaluate(async()=>{
  const makeStore=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},update:fn=>{value=structuredClone(value);fn(value);listeners.forEach(fn=>fn())}}}
  const api=registration.factory(id=>{
   if(id==='react')return React;
   if(id==='react/jsx-runtime')return {jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key}),Fragment:React.Fragment};
   if(id==='@xharness/dsh-client-ui-primitives')return new Proxy({}, {get:(_,key)=>key==='Toast'?({text})=>React.createElement('div',{role:'alert'},text):()=>null});
   if(id==='@xharness/cordis')return {Service:class{}};
   if(id==='@xharness/dsh-client-runtime/client')return {createSnapshotStore:makeStore};
   return {};
  });
  window.saved={provider:'p',model:'large',reasoningEffort:'max',contextWindowTokens:65536};window.calls=[];window.refreshes=0;window.loads=0;window.offline=false;window.locked=false;window.pendingRefresh=false;
  window.groups=[{id:'p',models:[{id:'large',name:'Large',contextWindow:131072,contextWindowSource:'provider_reported',reasoning:{defaultEffort:'high',efforts:[{id:'high',name:'高'},{id:'max',name:'极高'}]}},{id:'small',name:'Small',contextWindow:32768},{id:'unknown',name:'Unknown'}]}];
  const sessions={models:async(payload)=>{loads++;if(payload?.refreshCapabilities){refreshes++;if(pendingRefresh)await new Promise(resolve=>{window.releaseRefresh=resolve})}if(offline)throw Error('offline');return {result:{ok:true,value:{current:saved,groups,failures:[],routable:true}}}},selectModel:async payload=>{if(offline)throw Error('offline');calls.push(payload);saved={...payload};delete saved.sessionId;return {result:{ok:true,value:{selected:saved}}}}};
  window.root=ReactDOM.createRoot(document.getElementById('root'));
  window.mount=async()=>{window.directory=new api.ModelDirectory(sessions,'test',()=>true);await directory.load();window.render=()=>root.render(React.createElement(api.XHarnessModelSelect,{t:(key,args)=>({'trigger.aria':'选择模型 '+args?.model,'trigger.ariaEffort':'选择模型 '+args?.model,'menu.model':'模型','menu.effort':'思考强度','menu.aria':'模型设置','error.action':'模型操作失败：'+args?.message,'effort.trigger':'思考：'+args?.effort,'effort.unknown':'默认','effort.disabled':'未配置','effort.providerDefault':'默认','effort.unknownHint':'尚未获取可调档位，继续使用模型默认设置。','effort.disabledHint':'当前配置关闭了思考档位调整，可在管理模型中修改。','capability.check':'检查能力','capability.checking':'检查中…','capability.unknown':'未提供能力信息','capability.stale':'保留上次档位'}[key]??key),locked:locked,available:true,directory:directory.store,load:(refresh)=>directory.load(refresh).catch(()=>{}),select:s=>directory.select(s).then(()=>true,()=>false)}));render()};
  await mount();
 })

 const trigger=()=>page.getByRole('button',{name:/^选择模型/});
 const openMenu=async()=>{if(await trigger().getAttribute('aria-expanded')!=='true')await trigger().click()};
 const openContext=async()=>{await openMenu();await page.getByRole('menuitem',{name:/上下文容量/}).click();await page.getByRole('textbox',{name:'上下文 Token 数量'}).waitFor()};
 const closeAll=async()=>{await page.keyboard.press('Escape');await page.keyboard.press('Escape')};
 const legacy=process.env.UI_TEST_IMPL==='legacy';
 const effortTrigger=()=>page.getByRole('button',{name:/^思考：/});
 const openEffort=async()=>{if(legacy){await openMenu();await page.getByRole('menuitem',{name:/思考强度/}).click()}else if(await effortTrigger().getAttribute('aria-expanded')!=='true')await effortTrigger().click()};
 assert.equal(await page.getByRole('button').count(),legacy?1:2,'model and effort are adjacent, no third composer control');
 if(!legacy){
  assert.equal(await effortTrigger().textContent(),'思考：极高');
  const before=await page.evaluate(()=>loads);
  for(let i=0;i<3;i++){await openEffort();await page.keyboard.press('Escape')}
  assert.equal(await page.evaluate(()=>loads),before,'opening known choices must not fetch/probe');
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'思考：极高','Escape restores effort opener');
 }
 await (legacy?openMenu():openEffort());await page.getByRole('menuitem',{name:legacy?'刷新模型能力':'检查能力'}).click();await page.waitForFunction(()=>refreshes===1);
 await closeAll();
 await openContext();assert.equal(await page.getByRole('textbox').inputValue(),'65536');
 await page.getByRole('textbox').fill('131073');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>calls.length),0);
 await page.getByRole('textbox').fill('32768');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>saved.contextWindowTokens===32768);assert.equal(await page.evaluate(()=>saved.reasoningEffort),'max');
 await closeAll();await openEffort();
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
 if(process.env.UI_TEST_IMPL !== 'legacy')await page.getByRole('menuitem',{name:'menu.custom',exact:true}).click();
 await page.getByRole('menuitemradio',{name:'Small',exact:true}).click();
 await page.waitForFunction(()=>saved.model==='small');assert.equal(await page.evaluate(()=>saved.contextWindowTokens),undefined,'new model must not inherit old soft context');
 await openContext();assert.equal(await page.getByRole('textbox').inputValue(),'32768');await closeAll();
 if(!legacy){
  // A failed save cannot optimistically display the requested level.
  await page.evaluate(async()=>{saved={provider:'p',model:'large',reasoningEffort:'max',contextWindowTokens:16384};await directory.load()});
  await openEffort();await page.evaluate(()=>{offline=true});await page.getByRole('menuitemradio',{name:'高',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'offline'}).waitFor();assert.equal(await effortTrigger().textContent(),'思考：极高');
  assert.equal(await page.getByRole('menuitemradio',{name:'极高',exact:true}).getAttribute('aria-checked'),'true');
  await page.evaluate(()=>{offline=false});await closeAll();
  // Unknown is not unsupported; inspection stays in-place and does not choose a level.
  await page.evaluate(async()=>{saved={provider:'p',model:'unknown'};await directory.load()});
  await openEffort();await page.getByText('尚未获取可调档位，继续使用模型默认设置。').waitFor();
  assert.equal(await page.getByRole('menuitemradio').count(),0);
  await page.evaluate(()=>{groups[0].models[2].reasoning={efforts:[{id:'off',name:'关闭'},{id:'on',name:'开启'}]};pendingRefresh=true});
  await page.getByRole('menuitem',{name:'检查能力'}).click();
  await page.getByRole('menuitem',{name:'检查能力'}).waitFor();assert.equal(await page.getByRole('menuitem',{name:'检查能力'}).isDisabled(),true);
  await page.evaluate(()=>{pendingRefresh=false;releaseRefresh()});
  await page.getByRole('menuitemradio',{name:'开启',exact:true}).waitFor();
  assert.equal(await page.getByRole('menuitemradio').count(),3,'only default and actual advertised on/off, no invented low/high');
  await page.getByRole('menuitemradio',{name:'开启',exact:true}).click();await page.waitForFunction(()=>saved.reasoningEffort==='on');
  assert.equal(await effortTrigger().textContent(),'思考：开启');
  // Failure retains last good levels, with a retry for discovery rather than catalog-only.
  await page.evaluate(async()=>{groups[0].models[2].reasoningCapability={state:'supported',stale:true,source:'last_known_good'};await directory.load();offline=true});
  await openEffort();await page.getByText('保留上次档位').waitFor();
  await page.getByRole('menuitem',{name:'检查能力'}).click();await page.getByRole('menu',{name:'思考强度'}).getByText(/模型操作失败/).waitFor();
  assert.equal(await page.getByRole('menuitemradio',{name:'开启',exact:true}).getAttribute('aria-checked'),'true');
  const before=await page.evaluate(()=>refreshes);await page.evaluate(()=>{offline=false});await page.getByRole('button',{name:'action.reload'}).click();await page.waitForFunction(before=>refreshes===before+1,before);
  await closeAll();
  // Explicitly disabled configurations do not expose stale cached choices.
  await page.evaluate(async()=>{groups[0].models[2].reasoningCapability={state:'disabled'};await directory.load()});
  await openEffort();await page.getByText('当前配置关闭了思考档位调整，可在管理模型中修改。').waitFor();assert.equal(await page.getByRole('menuitemradio').count(),0);
  await closeAll();await page.evaluate(()=>{locked=true;render()});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].filter(b=>b.getAttribute('aria-haspopup')==='menu').every(b=>b.disabled));assert.equal(await effortTrigger().isDisabled(),true);assert.equal(await trigger().isDisabled(),true);
  await page.evaluate(async()=>{locked=false;groups[0].models[2].reasoningCapability={state:'supported'};render();await directory.load()});
  for(const width of [900,520,320]){
   await page.setViewportSize({width,height:620});await openEffort();
   const box=await page.getByRole('menu',{name:'思考强度'}).boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=620,JSON.stringify(box));await closeAll();
  }
  // Long provider vocabularies stay scrollable and keyboard focus starts at the current level.
  await page.evaluate(async()=>{groups[0].models[2].reasoning={defaultEffort:'l39',efforts:Array.from({length:40},(_,i)=>({id:'l'+i,name:'Level '+i}))};saved={provider:'p',model:'unknown',reasoningEffort:'l39'};await directory.load()});
  await page.setViewportSize({width:520,height:620});await openEffort();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-checked')==='true');
  assert.equal(await page.getByRole('menuitemradio').count(),40);
  assert.equal(await page.getByRole('menuitemradio',{name:'Level 39',exact:true}).evaluate(el=>{const viewport=el.parentElement.getBoundingClientRect(),item=el.getBoundingClientRect();return item.top>=viewport.top&&item.bottom<=viewport.bottom}),true,'selected level is not clipped');
  await page.keyboard.press('ArrowUp');assert.equal(await page.getByRole('menuitemradio',{name:'Level 38',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Enter');await page.waitForFunction(()=>saved.reasoningEffort==='l38');
  // Frozen UI fixture is checked against the pinned dependency by Rust wire tests.
  const bundled=JSON.parse(readFileSync(new URL('./fixtures/reasoning-catalog-v0.1.1.json',import.meta.url),'utf8'));
  for(const [id,profile] of Object.entries(bundled.profiles)){
   await closeAll();
   await page.evaluate(async({id,profile})=>{
    groups[0].models[2]={id,name:id,reasoning:{defaultEffort:profile.default_effort,efforts:profile.efforts.map(e=>({id:e.id,name:e.name}))},reasoningCapability:{state:'supported',source:'documented'}};
    saved={provider:'p',model:id,reasoningEffort:profile.default_effort};await directory.load();
   },{id,profile});
   await page.getByRole('button',{name:'选择模型 '+id,exact:true}).waitFor();await openEffort();
   assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(),profile.efforts.map(e=>e.name));
   assert.equal(await page.getByRole('menuitemradio').filter({has:page.locator('[aria-checked=true]')}).count(),0); // selection is on the option itself, not a nested fake badge
   const chosen=profile.efforts.find(e=>e.id===profile.default_effort);
   assert.equal(await page.getByRole('menuitemradio',{name:chosen.name,exact:true}).getAttribute('aria-checked'),'true');
   if(id==='glm-5.3')assert.equal(await page.getByRole('menuitemradio',{name:'关闭',exact:true}).count(),0);
   const target=profile.efforts[0];await page.getByRole('menuitemradio',{name:target.name,exact:true}).click();
   await page.waitForFunction(id=>saved.reasoningEffort===id,target.id);
  }
  if(process.env.UI_TEST_SCREENSHOT){await page.setViewportSize({width:900,height:620});await openEffort();await page.screenshot({path:process.env.UI_TEST_SCREENSHOT})}
 }
 console.log(`${engine}: ${legacy?'legacy nested menu':'adjacent reasoning control, no opening probes, truthful discovery, retry, on/off, locked and narrow layout'}, authoritative save/reload, effort preservation, switch and context validation passed`);
} finally {await browser.close()}
