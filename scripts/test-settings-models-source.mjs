// Current distribution is the behavior oracle, not an upstream release.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { compileSourceModules } from './build-source-modules.mjs'
const id='@xharness/dsh-client-ui-settings-models';
const names=['adopt','ModelsSettingsStore','deriveKeyRef','protocolChoices','providerUsable','onboardingReadiness','apiKeyFailure','parseCapacity','formatCapacity','validateDeepSeekModels','modelDrafts','pathOps','removeProviderProfile','needsSetup','ModelsSection','ModelListEditor','ProviderEditor','CustomProviderCard'];
const oldSource=readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8');
const oldTest=oldSource.replace('return module.exports;',`Object.assign(exports,{${names.join(',')}});return module.exports;`);
const roots=[{id,source:'src/modules/settings-models/index.ts'},{id:id+'/test',source:'src/modules/settings-models/test-exports.ts'}];
const outputs=compileSourceModules(new URL('../ui',import.meta.url).pathname,roots);
const current=outputs.get(id).bytes.toString(), compiled=outputs.get(id+'/test').bytes.toString();
const json=x=>JSON.parse(JSON.stringify(x)); const ok=value=>({result:{ok:true,value}}), bad=message=>({result:{ok:false,error:{code:'test',message}}});
function harness(source){let registration;const styles=[];
 const makeStore=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;for(const fn of listeners)fn()},update:fn=>{value={...value};fn(value);for(const fn of listeners)fn()}}};
 const context={window:{__ModuleLoader__:{load:row=>{registration=row}}},document:{querySelector:()=>null,createElement:()=>({dataset:{}}),head:{appendChild:x=>styles.push(x)}},console,structuredClone};vm.runInNewContext(source,context);
 return {styles,plugin:registration.factory(name=>{
  if(name==='react')return{};if(name==='react/jsx-runtime')return{jsx(){},jsxs(){}};
  if(name==='@xharness/dsh-client-ui-primitives')return new Proxy({},{get:(_t,k)=>k});
  if(name==='@xharness/dsh-client-runtime/client')return{createSnapshotStore:makeStore};throw Error(name);
 })};}
const apis=[harness(oldTest),harness(compiled)];
const getPath=(v,p)=>p.reduce((v,k)=>v?.[k],v);
const schema={rehydrate:x=>x,nodeAtPath:(r,p)=>getPath(r,p),getPath,hasPath:(v,p)=>getPath(v,p)!==undefined,validate:()=>undefined,setPath(){},deletePath(){}};
const namespace={ns:'llm-pi-ai',schema:{},revision:7,base:{providers:{builtin:{apiKeyEnv:'BUILTIN_API_KEY'}}},user:{providers:{custom:{apiKeyEnv:'CUSTOM_API_KEY',unknown:{keep:true}}}},value:{providers:{builtin:{apiKeyEnv:'BUILTIN_API_KEY'},custom:{apiKeyEnv:'CUSTOM_API_KEY',unknown:{keep:true}}}}};
const entries=['builtin','custom'].map(provider=>({provider,displayName:provider,settingsNs:namespace.ns,settingsPath:['providers',provider],active:true}));
function mirror(view={namespaces:[namespace],writable:true,hasDocument:true}){return{getSnapshot:()=>({status:'ready',view,error:null}),ensure:async()=>{},acceptView(){},subscribe:()=>()=>{}}}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}

test('published ABI, exact CSS and no removed onboarding slot',async()=>{
 const old=harness(oldSource),next=harness(current);assert.deepEqual(Object.keys(next.plugin).sort(),Object.keys(old.plugin).sort());assert.deepEqual(json(next.plugin.inject),json(old.plugin.inject));assert.deepEqual(json(next.styles),json(old.styles));
 const receipts=[];for(const{plugin}of[old,next]){const slots=[],dicts=[],events=[],cleanup=[];const scope={getSnapshot:()=>({status:'ready',value:{accepted:false},writable:true}),subscribe:()=>()=>{},set:async()=>{}};
 const ctx={effect:fn=>{const result=fn();if(typeof result==="function")cleanup.push(result)},locale:{register:(...v)=>dicts.push(v),bind:()=>k=>k},get:()=>({api:{}}),settingsSchema:schema,settingsScope:{describe:()=>mirror(),bind:()=>scope},remote:{$on:(n)=>{events.push(n);return()=>{}}},on:n=>{events.push(n);return()=>{}},slots:{inject:(_n,fn)=>fn(),register:(spec,component)=>slots.push({spec,component})}};
 plugin.apply(ctx);const managed=slots.find(row=>row.spec.id==='managed-account');if(plugin===next.plugin)assert.ok(managed,'new managed service section registered');const original=slots.filter(row=>row.spec.id!=='managed-account');dicts.splice(0,dicts.length,...dicts.filter(row=>row[0]!=='xharness-managed-account'));slots.splice(0,slots.length,...original);assert.equal(slots.length,1);assert.equal(slots[0].spec.name,'settings.section');cleanup.forEach(fn=>fn());receipts.push({inject:json(plugin.inject),dicts:json(dicts),events,slot:{...slots[0].spec,inject:undefined,label:slots[0].spec.label()}});}
 assert.deepEqual(receipts[1],receipts[0]);
});
test('API-key validation permits literal keys but rejects pasted quotes/env or unsafe chars',()=>{
 const drafts=['',' ',' sk-test ','sk-test','KEY=value','ABCD==','a=b',"'sk-test'",'`sk-test`','"sk-test"','sk-中文','sk-\u0000','sk-test\nmore','sk-test\tmore'];for(const draft of drafts)assert.equal(apis[1].plugin.apiKeyFailure(draft),apis[0].plugin.apiKeyFailure(draft));
 assert.equal(apis[1].plugin.apiKeyFailure(' sk-test '),undefined);assert.equal(apis[1].plugin.apiKeyFailure('KEY=value'),'keyIllegalCharacters');
});
test('capacity parser/formatter and complete model validation match edge vocabulary',()=>{
 for(const raw of ['','0','1','1k','128K','1m','1.5K','12,345',' 8192 ','1e3','Infinity','-1','9007199254740992','1.1','2_048'])assert.equal(apis[1].plugin.parseCapacity(raw),apis[0].plugin.parseCapacity(raw),raw);
 for(const v of [1,1024,1000,128000,1048576,1200,262144])assert.equal(apis[1].plugin.formatCapacity(v),apis[0].plugin.formatCapacity(v));
 for(const v of [undefined,[],{},[{id:'a'}],[{id:'a',contextWindow:100,maxTokens:101}],[{id:'',contextWindow:100,maxTokens:5}],[{id:'a',contextWindow:100,maxTokens:5},{id:'a'}],[{id:'a',contextWindow:100,maxTokens:5,hidden:{keep:true},reasoning:{efforts:['high']}}]]){assert.deepEqual(json(apis[1].plugin.validateDeepSeekModels(v)??null),json(apis[0].plugin.validateDeepSeekModels(v)??null));assert.deepEqual(json(apis[1].plugin.modelDrafts(v)),json(apis[0].plugin.modelDrafts(v)));}
});
test('minimal path ops preserve unknown fields and meaningful field deletion',()=>{
 const before={api:'openai',models:[{id:'a',unknown:true}],extension:{keep:true},unset:true};const after={...before,api:'anthropic'};delete after.unset;
 for(const{plugin}of apis){assert.deepEqual(json(plugin.pathOps(['providers','p'],before,after)),[{op:'set',path:['providers','p','api'],value:'anthropic'},{op:'unset',path:['providers','p','unset']}]);assert.deepEqual(json(plugin.pathOps([],before,{...before})),[]);}
});
test('provider/settings/credentials join loads once in parallel and never serializes secrets',async()=>{
 for(const{plugin}of apis){const calls=[];const api={llm:{providers:async p=>{calls.push(['providers',p]);return ok({providers:entries})}},credentials:{describe:async p=>{calls.push(['credentials',p]);return ok({credentials:{BUILTIN_API_KEY:{configured:true,writable:false},CUSTOM_API_KEY:{configured:false,writable:true}}})}}};
 const c=new plugin.ModelsSettingsStore(api,schema,mirror());assert.equal(c.store.getSnapshot().status,'idle');await c.load();const state=c.store.getSnapshot();assert.equal(state.status,'ready');assert.deepEqual(json(calls),[['providers',{}],['credentials',{refs:['BUILTIN_API_KEY','CUSTOM_API_KEY']}]]);assert.deepEqual(json(state.rows.map(r=>({id:r.entry.provider,configured:r.configured,removable:r.removable,credential:r.credential}))),[{id:'builtin',configured:true,removable:false,credential:{configured:true,writable:false}},{id:'custom',configured:true,removable:true,credential:{configured:false,writable:true}}]);assert.equal(plugin.providerUsable(state.rows[0]),true);assert.equal(plugin.providerUsable(state.rows[1]),false);}
});
test('latest generation wins both provider phase and credential phase',async()=>{
 for(const{plugin}of apis){const first=deferred();let count=0;const api={llm:{providers:async()=>++count===1?first.promise:ok({providers:[]})},credentials:{describe:async()=>ok({credentials:{}})}};const c=new plugin.ModelsSettingsStore(api,schema,mirror());const pending=c.load();await c.load();first.resolve(ok({providers:entries}));await pending;assert.equal(c.store.getSnapshot().rows.length,0);
 const keyWait=deferred();let credCount=0;api.llm.providers=async()=>ok({providers:entries});api.credentials.describe=async()=>++credCount===1?keyWait.promise:ok({credentials:{CUSTOM_API_KEY:{configured:true,writable:true}}});const a=c.load();await new Promise(resolve=>setImmediate(resolve));const b=c.load();await b;keyWait.resolve(ok({credentials:{CUSTOM_API_KEY:{configured:false,writable:true}}}));await a;assert.equal(c.store.getSnapshot().rows[1].credential.configured,true);}
});
test('credential failures enrich usable rows without erasing held provider state',async()=>{
 for(const{plugin}of apis){let failure=false;const api={llm:{providers:async()=>failure?bad('offline'):ok({providers:entries})},credentials:{describe:async()=>bad('credential unavailable')}};const c=new plugin.ModelsSettingsStore(api,schema,mirror());await c.load();assert.equal(c.store.getSnapshot().status,'ready');assert.equal(c.store.getSnapshot().credentialError,'credential unavailable');failure=true;await c.load();assert.equal(c.store.getSnapshot().status,'error');assert.equal(c.store.getSnapshot().rows.length,2);
 const absent=new plugin.ModelsSettingsStore(api,schema,mirror(undefined));await absent.load();assert.equal(absent.store.getSnapshot().status,'error');}
});
test('background invalidation is lazy until section loaded',()=>{
 for(const{plugin}of apis){let count=0,status='idle';const c={store:{getSnapshot:()=>({status})},load:()=>{count++;return Promise.resolve()}};plugin.refreshIfLoaded(c);assert.equal(count,0);status='ready';plugin.refreshIfLoaded(c);assert.equal(count,1);}
});
test('profile removal respects credential-first idempotent retry and settings failure',async()=>{
 for(const{plugin}of apis){const calls=[];let failCredential=true,failSettings=false;const api={credentials:{unset:async p=>{calls.push(['credential',p]);return failCredential?bad('denied'):ok({})}},settings:{mutate:async p=>{calls.push(['settings',p]);return failSettings?bad('conflict'):ok(namespace)}}};const c={load:async()=>calls.push(['load'])};const target={settingsNs:'llm-pi-ai',settingsPath:['providers','custom'],credentialRef:'CUSTOM_API_KEY'};
 assert.equal(await plugin.removeProviderProfile(api,c,target),'denied');assert.equal(calls.length,1);failCredential=false;failSettings=true;assert.equal(await plugin.removeProviderProfile(api,c,target),'conflict');failSettings=false;assert.equal(await plugin.removeProviderProfile(api,c,target),undefined);assert.deepEqual(json(calls.at(-2)),['settings',{ns:'llm-pi-ai',ops:[{op:'unset',path:['providers','custom']}]}]);assert.deepEqual(calls.at(-1),['load']);}
});

test('discovered image capability preserves true/false/unknown without guessing or rewriting fields',()=>{
 for(const imageInput of [undefined,true,false,'yes',null]){const candidate={id:'vision',name:'Vision',contextWindow:8192,maxTokens:2048,reasoning:{efforts:[{id:'high'}]},imageInput};const rows=apis.map(({plugin})=>json(plugin.adopt(candidate)));assert.deepEqual(rows[1],rows[0]);assert.equal(rows[1].imageInput,typeof imageInput==='boolean'?imageInput:undefined);assert.deepEqual(rows[1].reasoning,candidate.reasoning);}
});

// The managed account seam reuses Host CAS writes and credential/keyring storage.
test('managed credentials never overwrite unrelated provider and stop on CAS failure',async()=>{
 const save=apis[1].plugin.saveManagedAccess;const calls=[];const access={status:'authorized',accessToken:'private-fixture',baseURL:'https://engine.xxdevs.com/api/inference/v1',models:[{id:'fixture',contextWindow:1000,maxTokens:100}]};
 const ns=json(namespace);const describe=mirror({namespaces:[ns],writable:true,hasDocument:true});describe.acceptView=()=>{};
 const api={settings:{mutate:async p=>{calls.push(p);return ok(ns)}},credentials:{set:async p=>{calls.push(p);return ok({})}}};
 await save(api,describe,access);assert.deepEqual(json(calls[0].ops[0].path),['providers','xharness-managed']);assert.equal(calls[0].expectedRevision,7);assert.equal(calls[1].ref,'XHARNESS_MANAGED_API_TOKEN');assert.equal(calls[1].value,access.accessToken);
 ns.value.providers['xharness-managed']={api:'openai-completions',apiKeyEnv:'OWN_KEY',baseURL:access.baseURL};calls.length=0;await assert.rejects(()=>save(api,describe,access));assert.equal(calls.length,0);
 delete ns.value.providers['xharness-managed'];api.settings.mutate=async()=>bad('conflict');await assert.rejects(()=>save(api,describe,access));assert.equal(calls.length,0);
});
