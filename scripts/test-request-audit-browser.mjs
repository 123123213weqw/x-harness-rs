// Actual shipped React, primitives, workspace owner and product flow; only the
// host services/slot harness are fixtures. No running App or user data is used.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactUnitScope,contextViewScope } from './fixtures/context-artifact-scope.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const implementation=process.env.UI_TEST_IMPL??'canonical'
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps', 'package.json'))
const engines = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const unit='src/modules/context/index.js'
const raw=implementation==='canonical'?undefined:ownedViewModuleTestInput('@xlang/xharness-client-ui-context')
const source=implementation==='canonical'?contextViewScope():implementation==='legacy'
  ? raw.replace('return module.exports','Object.assign(exports,{HarnessView});return module.exports')
  : artifactUnitScope({source:raw,root:unit},{apply:{unit,member:'apply'},HarnessView:{unit,member:'HarnessView'}},{[unit]:['HarnessView']})
if(implementation==='legacy')assert.equal(raw.split('return module.exports').length,2,'one original frozen factory return')
const browser = await engines[engine].launch({ headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', error => {if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  page.setDefaultTimeout(8000)
  await installOwnedViewPlatform(page,implementation==='legacy'?'legacy':'source')
  let fail=false, delayed=null;const calls=[];
  await page.route('**/api/session.requestSnapshot',async route=>{
    const request=route.request().postDataJSON(),{payload}=request;calls.push(payload);
    assert.equal(request.type,'client-request');assert.equal(request.method,'session.requestSnapshot');assert.equal(typeof request.rpcId,'string');
    if(payload.seq===10)await new Promise(resolve=>delayed=resolve);
    const omitted=payload.seq===20||payload.seq===21;
    const header=omitted
      ? {provider:'test',model:'model',input:[],tools:[],options:{auditSnapshot:{kind:'omitted',reason:payload.seq===20?'capture_disabled':'archive_failed'},inputMessageCount:4,toolCount:2}}
      : {provider:'test',model:'model',input:[{role:'user',content:'Full request '+payload.sessionId+' '+payload.seq}],system:'System restored '+payload.sessionId+' '+payload.seq,tools:[{name:'read',description:'restored tool'}],options:{}};
    const result=fail?{ok:false,error:{message:'audit unavailable'}}:{ok:true,value:{...payload,header}};
    await route.fulfill({contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:request.rpcId,result})}).catch(()=>{});
  });
  await page.evaluate(() => { document.getElementById('root').replaceChildren(); window.registrations = {}; window.__ModuleLoader__ = { load: reg => { registrations[reg.id] = reg } } })
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{
    const React=staticModules.react,DOM=staticModules['react-dom'];
    const component=registrations['@xlang/xharness-client-ui-context'].factory(id=>staticModules[id]);
    const cleanups=[],tabs=[];window.disposeContext=()=>{for(const cleanup of cleanups.splice(0))cleanup()};
    component.apply({locale:{register(){},bind:()=>key=>key},effect:fn=>{const cleanup=fn();if(typeof cleanup==='function')cleanups.push(cleanup)},conversationEvents:{register:()=>()=>{}},conversationViews:{register:()=>()=>{}},slots:{inject:(_name,fn)=>fn(),register:spec=>{tabs.push(spec.id);return()=>{}}}});window.registeredTabs=tabs;
    const root=DOM.createRoot(document.getElementById('root'));let state;
    window.show=(seq,sessionId='a')=>{
      const requests=[seq].map(seq=>({kind:'request',seq,time:seq*1000,reason:undefined,header:{options:{snapshotOnDemand:true,inputMessageCount:1}},turn:1,step:seq}));
      state={views:new Map([['xharness-context',{requests,compactions:[]} ]])};
      DOM.flushSync(()=>root.render(React.createElement(component.HarnessView,{sessionId,useSession:selector=>selector(state)})));
    };
    window.showWithCompaction=()=>{
      state={views:new Map([['xharness-context',{requests:[4,5,7].map(seq=>({kind:'request',seq,time:seq*1000,reason:undefined,header:{options:{snapshotOnDemand:true}},turn:1,step:seq})),compactions:[{kind:'compaction',seq:6,time:6000,summary:'compacted',beforeCount:2,afterCount:1}]}]])};
      DOM.flushSync(()=>root.render(React.createElement(component.HarnessView,{sessionId:'compact',useSession:selector=>selector(state)})));
    };
    window.unmount=()=>DOM.flushSync(()=>root.render(null));show(1);
  });
  if(implementation!=='legacy')assert.deepEqual(await page.evaluate(()=>registeredTabs),['harness'],'no Context page is registered');
  await page.getByText('System restored a 1',{exact:true}).waitFor();assert.equal(calls.length,1);
  assert.equal(await page.getByText('Full request a 1',{exact:true}).count(),0,'Harness does not render private input bodies');
  await page.evaluate(()=>document.fonts.ready);const initialPixelsSha256=createHash('sha256').update(await page.locator('#root').screenshot({animations:'disabled'})).digest('hex');
  await page.evaluate(()=>show(2,'a'));
  await page.getByText('System restored a 2',{exact:true}).waitFor();
  fail=true;await page.evaluate(()=>show(3));await page.getByRole('alert').waitFor();
  fail=false;await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByText('System restored a 3',{exact:true}).waitFor();
  await page.evaluate(()=>show(10));
  await page.waitForFunction(()=>document.body.textContent.includes('正在'));
  while(!delayed)await new Promise(resolve=>setTimeout(resolve,10));
  await page.evaluate(()=>show(11,'b'));await page.getByText('System restored b 11',{exact:true}).waitFor();
  delayed();await page.waitForTimeout(100);assert.equal(await page.getByText('System restored a 10',{exact:true}).count(),0);
  for(let i=12;i<18;i++){await page.evaluate(i=>show(i,'b'),i);await page.getByText('System restored b '+i,{exact:true}).waitFor();}
  assert.equal(await page.getByText('System restored b 11',{exact:true}).count(),0);
  await page.evaluate(()=>showWithCompaction());await page.getByText('System restored compact 7',{exact:true}).waitFor();
  assert.deepEqual(calls.filter(c=>c.sessionId==='compact').map(c=>c.seq),[7],'compaction history does not hydrate removed Context diff bodies');
  if(implementation!=='legacy')assert.equal(await page.getByRole('button',{name:'Diff',exact:true}).count(),0);
  for(const [seq,reason] of [[20,'capture_disabled'],[21,'archive_failed']]){
    await page.evaluate(seq=>show(seq,'b'),seq);
    if(implementation==='legacy') {
      await page.getByText(reason==='archive_failed'?/完整请求诊断捕获失败/:/完整请求诊断未开启/).waitFor();
      await page.getByText('2 个模型可见工具（定义未记录）',{exact:true}).waitFor();
    } else {
      await page.getByText(reason==='archive_failed'?'未记录；此请求的诊断捕获失败。':'未记录；此请求未开启完整诊断。',{exact:true}).first().waitFor();
      await page.getByText('2 个工具',{exact:true}).waitFor();
      assert.equal(await page.getByText(/没有匹配的工具/).count(),0);
    }
    assert.equal(await page.getByText('System restored b '+seq,{exact:true}).count(),0);
  }
  await page.evaluate(()=>unmount());assert.equal(await page.locator('#root').textContent(),'');
  await page.evaluate(()=>disposeContext());assert.equal(await page.locator('#xharness-context-inspector-style').count(),0);
  assert.deepEqual(errors,[]);
  console.log(engine+' '+implementation+': Harness-only on-demand hydration, retry, late response, switching sessions, bounded selection, unmount passed (actual platform/production closure)');
  console.log(JSON.stringify({engine,implementation,actualPlatform:true,productionLexicalClosure:true,genuineProjectionDTO:true,correlatedHostEnvelope:true,selectedRequestAuditAssertions:true,styleLifecycle:true,initialPixelsSha256,pageErrors:errors}));
} finally {await browser.close()}
