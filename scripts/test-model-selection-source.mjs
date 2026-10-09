// Migration acceptance: strict source vs retained current distribution.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { compileSourceModules } from './build-source-modules.mjs'
const id='@xharness/dsh-client-ui-model-selection';
const oldSource=readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8');
const compiled=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id,source:'src/modules/model-selection/index.ts'}]).get(id).bytes.toString();
const json=x=>JSON.parse(JSON.stringify(x));
function harness(source) {
 let registration;const styles=[];
 const primitives=new Proxy({}, {get:(_target,key)=>key});
 const makeStore=initial=>{let value=initial;const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},update:fn=>{value=structuredClone(value);fn(value);for(const listener of listeners)listener()}}};
 const react={};const context={window:{__ModuleLoader__:{load:row=>{registration=row}}},document:{querySelector:()=>null,createElement:()=>({dataset:{}}),head:{appendChild:x=>styles.push(x)}},console};
 vm.runInNewContext(source,context);
 const plugin=registration.factory(name=>{
  if(name==='react')return react;
  if(name==='react/jsx-runtime')return {jsx(){},jsxs(){},Fragment:'fragment'};
  if(name==='@xharness/dsh-client-ui-primitives')return primitives;
  if(name==='@xharness/cordis')return {Service:class{constructor(ctx){this.ctx=ctx}},Context:{is:ctx=>ctx!==null&&typeof ctx==='object'}};
  if(name==='@xharness/dsh-client-runtime/client')return {createSnapshotStore:makeStore};
  throw Error('Unknown external '+name);
 });
 return{plugin,styles};
}
const apis=[harness(oldSource),harness(compiled)];
const current={provider:'p/x',model:'m/x',reasoningEffort:'ultra',contextWindowTokens:4096};
const model={id:'m/x',name:'Test',contextWindow:262144,contextWindowSource:'provider_reported',reasoning:{defaultEffort:'high',efforts:[{id:'off',name:'Off'},{id:'ultra',name:'Ultra'}]}};
const catalog={current,routable:true,groups:[{id:'p/x',name:'Provider',models:[model,{id:'other',name:'Other'}]}],failures:[]};
const ok=value=>({result:{ok:true,value}});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}

test('source export ABI and original styles retained with reviewed source-menu additions',()=>{
 assert.deepEqual(Object.keys(apis[1].plugin).sort(),Object.keys(apis[0].plugin).sort());
 assert.deepEqual(json(apis[1].plugin.inject),json(apis[0].plugin.inject));
 assert.equal(apis[1].styles.length, apis[0].styles.length);
 const old = json(apis[0].styles), next = json(apis[1].styles);
 assert.ok(next[0].textContent.startsWith(old[0].textContent), 'pre-existing styles stay intact');
 assert.match(next[0].textContent, /AbPDjW_sourceBadge/);
 assert.equal(next[0].dataset.pluginCss, old[0].dataset.pluginCss);
});
test('context validation uses selected model maximum and preserves complete selection',()=>{
 for(const {plugin}of apis){const state={...catalog,status:'ready',error:null};
  assert.deepEqual(json(plugin.xhContextSelection(state,' 262144 ')),{...current,contextWindowTokens:262144});
  for(const raw of ['','0','-1','262145','1.5','1e3','9007199254740992','Infinity'])assert.throws(()=>plugin.xhContextSelection(state,raw));
  assert.throws(()=>plugin.xhContextSelection({...state,current:{provider:'p/x',model:'other'}},'1'));
  assert.equal(plugin.xhModelInfo(state).effort,'ultra');
 }
});
test('reasoning discovery status uses provider-owned metadata',()=>{
 for(const {plugin}of apis)for(const[capability,expected]of [[{state:'disabled'},'已禁用配置'],[{stale:true},'沿用上次能力 · 待刷新'],[{source:'documented'},'厂商文档'],[{source:'provider_reported'},'服务端提供'],[{source:'last_known_good'},'上次有效能力'],[{},'已配置']]){
  const state={...catalog,groups:[{id:'p/x',name:'Provider',models:[{...model,reasoningCapability:capability}]}]};assert.equal(plugin.xhReasoningStatus(state),expected);
 }
});
test('load/select RPC fields, late load must not overwrite newer selection',async()=>{
 for(const {plugin}of apis){const old=deferred();const calls=[];const directory=new plugin.ModelDirectory({models:args=>{calls.push(args);return old.promise},selectModel:async args=>{calls.push(args);return ok({selected:args})}},'s',()=>true);
  const pending=directory.load(true);assert.equal(directory.store.getSnapshot().status,'loading');
  const next={provider:'p',model:'new',reasoningEffort:'low',contextWindowTokens:5000};await directory.select(next);old.resolve(ok(catalog));await pending;
  assert.equal(directory.store.getSnapshot().current.model,'new');assert.equal(directory.store.getSnapshot().status,'ready');
  assert.deepEqual(json(calls),[{sessionId:'s',refreshCapabilities:true},{sessionId:'s',...next}]);
 }
});
test('late transport failure cannot overwrite newer operation; active error retains catalog',async()=>{
 for(const {plugin}of apis){let mode='ok';const pending=deferred();const directory=new plugin.ModelDirectory({models:async()=>mode==='old'?pending.promise:mode==='bad'?Promise.reject(Error('offline')):ok(catalog),selectModel:async()=>ok({selected:current})},'s',()=>true);
  await directory.load();mode='old';const old=directory.load();await directory.select(current);pending.reject(Error('stale failure'));await assert.rejects(old,/stale failure/);assert.equal(directory.store.getSnapshot().status,'ready');
  mode='bad';await assert.rejects(directory.load(),/offline/);assert.equal(directory.store.getSnapshot().error,'offline');assert.equal(directory.store.getSnapshot().groups[0].models[0].id,'m/x');
 }
});
test('disposed late settlements and addressed subagents do not mutate directory',async()=>{
 for(const {plugin}of apis){const pending=deferred();const directory=new plugin.ModelDirectory({models:()=>pending.promise},'s',()=>true);const load=directory.load();directory.dispose();const before=json(directory.store.getSnapshot());pending.resolve(ok(catalog));await load;assert.deepEqual(json(directory.store.getSnapshot()),before);
  const blocked=new plugin.ModelDirectory({},'s',()=>false);await assert.rejects(blocked.load(),/addressed subagent/);await assert.rejects(blocked.select(current),/addressed subagent/);
 }
});
test('Host reset clears old state and reloads; rejected RPC publishes accurate operation error',async()=>{
 for(const {plugin}of apis){let loads=0;const directory=new plugin.ModelDirectory({models:async()=>{loads++;return ok(catalog)},selectModel:async()=>({result:{ok:false,error:{code:'conflict',message:'busy'}}})},'s',()=>true);await directory.load();await assert.rejects(directory.select(current),/session.selectModel failed: conflict: busy/);assert.equal(directory.store.getSnapshot().error,'conflict: busy');directory.resetConnected();assert.equal(directory.store.getSnapshot().current,null);await new Promise(resolve=>setImmediate(resolve));assert.equal(loads,2);assert.equal(directory.store.getSnapshot().current.model,'m/x');
 }
});
test('resolver cache, composer blocks and session disposal agree',async()=>{
 for(const {plugin}of apis){const cleanup=[];const blocks=[];const events=new Map();const scope={effect:fn=>{cleanup.push(fn())}};const sessions={scope:()=>scope,subagentAddress:()=>undefined};const wire={models:async()=>ok({...catalog,routable:false}),selectModel:async selected=>ok({selected})};const ctx={get:name=>({sessions,connection:{api:{sessions:wire}},conversation:{blocks:{set:(...args)=>blocks.push(args)}}}[name]),on:(name,fn)=>events.set(name,fn),remote:{$on:(name,fn)=>events.set(name,fn)}};
  const resolver=new plugin.ModelDirectoryResolver(ctx,{blockReason:()=> 'Unavailable'});const directory=resolver.directoryFor('s');assert.equal(resolver.directoryFor('s'),directory);await directory.load();assert.deepEqual(json(blocks.at(-1)),['s',{reason:'Unavailable'}]);cleanup.forEach(fn=>fn());assert.equal(directory.disposed,true);assert.equal(resolver.live.directories.size,0);assert.deepEqual(json(blocks.at(-1)),['s',null]);
 }
});
test('/model command, opaque slash ids, dynamic default effort and composer injection agree',async()=>{
 const receipts=[];
 for(const {plugin}of apis){const registrations=[];const slots=[];const locales=[];const directory=new plugin.ModelDirectory({models:async()=>ok(catalog),selectModel:async args=>ok({selected:args})},'s',()=>true);const emitted=[];const ctx={emit:(...args)=>emitted.push(args),effect:fn=>fn(),locale:{register:(...args)=>locales.push(args),bind:()=>key=>key},plugin(){},inject:(_names,fn)=>fn(ctx),get:()=>({register:row=>registrations.push(row)}),modelDirectories:{directoryFor:()=>directory},sessions:{subagentAddress:()=>undefined},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>slots.push({spec,component})}};
  plugin.apply(ctx);const command=registrations[0];const rows=await command.ui.options({sessionId:'s'});assert.equal(rows[0].active,true);await command.ui.onSelect({id:'p/x/m/x'},{sessionId:'s'});assert.equal(directory.store.getSnapshot().current.reasoningEffort,'ultra');assert.equal(directory.store.getSnapshot().current.contextWindowTokens,undefined);await assert.rejects(command.ui.onSelect({id:'stale'},{sessionId:'s'}),/failed to load/);const injected=slots[0].spec.inject('s');assert.equal(injected.available,true);if(plugin===apis[1].plugin){injected.manageModels();assert.deepEqual(json(emitted),[['settings/open-section','models']]);}receipts.push({locales:json(locales),rows:json(rows),slotName:slots[0].spec.name});
 }
 for (const lang of ['zh','en']) {
  const added = receipts[1].locales[0][1][lang];
  const before = receipts[0].locales[0][1][lang];
  assert.deepEqual(Object.keys(added).filter(key => !(key in before)).sort(), ['empty.custom','menu.back','menu.custom','menu.manage','source.account','source.accountHint']);
  for (const key of Object.keys(before)) assert.equal(added[key], before[key]);
 }
 assert.deepEqual({...receipts[1],locales:undefined},{...receipts[0],locales:undefined});
});
