import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { patchModelControls } from './patch-model-controls.mjs'
const bundle = readFileSync(new URL('../ui/dist/plugins/@deepseek-ai/dsh-client-ui-model-selection/client.js', import.meta.url))
assert.equal(patchModelControls(bundle).toString(), bundle.toString().replaceAll('\r\n', '\n'), 'packaged extension must match product source; patch is idempotent')
let registration
vm.runInNewContext(bundle.toString(), { window: { __ModuleLoader__: { load(x) { registration=x } } } })
function createSnapshotStore(snapshot) {
  const listeners = new Set()
  return { getSnapshot:()=>snapshot, subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}, update:fn=>{snapshot=structuredClone(snapshot);fn(snapshot);listeners.forEach(fn=>fn())} }
}
const api = registration.factory(id => {
  if(id==='@deepseek-ai/cordis')return {Service:class{}}
  if(id==='@deepseek-ai/dsh-client-runtime/client')return {createSnapshotStore}
  if(['react','react/jsx-runtime','@deepseek-ai/dsh-client-ui-primitives'].includes(id))return {}
  throw new Error(id)
})
const current={provider:'test',model:'large',reasoningEffort:'max',contextWindowTokens:65536}
const groups=[{id:'test',models:[{id:'large',contextWindow:131072,reasoning:{defaultEffort:'high',efforts:[{id:'high',name:'高'},{id:'max',name:'极高'}]}},{id:'small',contextWindow:32768}]}]
let persisted={...current}, captured=[], fail=false
const sessions={
 async models(){if(fail)throw Error('offline');return {result:{ok:true,value:{current:{...persisted},groups,failures:[],routable:true}}}},
 async selectModel(payload){if(fail)throw Error('offline');captured.push(payload);persisted={...payload};delete persisted.sessionId;return {result:{ok:true,value:{selected:{...persisted}}}}},
}
const directory=new api.ModelDirectory(sessions,'session-test',()=>true)
await directory.load()
let state=directory.store.getSnapshot()
const result=api.xhContextSelection(state,'32768')
assert.equal(result.reasoningEffort,'max');assert.equal(result.contextWindowTokens,32768)
await directory.select(result)
assert.equal(captured.at(-1).contextWindowTokens,32768,'RPC must forward soft budget')
const restored=new api.ModelDirectory(sessions,'session-test',()=>true)
await restored.load();assert.equal(restored.store.getSnapshot().current.contextWindowTokens,32768)
for(const raw of ['0','-1','1.2','NaN','Infinity','1e4','131073','9007199254740993','']) assert.throws(()=>api.xhContextSelection(state,raw),undefined,raw)
assert.equal(api.xhContextSelection(state,' 131072 ').contextWindowTokens,131072)
for(const maximum of [undefined,0,-1,NaN,Infinity,1.2]) {
 const noCap={current,groups:[{id:'test',models:[{id:'large',contextWindow:maximum}]}]}
 assert.throws(()=>api.xhContextSelection(noCap,'1024'))
}
const switched={...state,current:{provider:'test',model:'small'}}
assert.equal(api.xhModelInfo(switched).maximum,32768)
assert.equal(api.xhModelInfo(switched).effort,undefined)
assert.throws(()=>api.xhContextSelection(switched,'65536'))
fail=true
await assert.rejects(directory.load(),/offline/);assert.equal(directory.store.getSnapshot().status,'error')
await assert.rejects(directory.select(result),/offline/);assert.equal(directory.store.getSnapshot().status,'error')
fail=false
await directory.load();assert.equal(directory.store.getSnapshot().status,'ready')
// Older catalog refresh cannot overwrite a more recent user selection.
let release
sessions.models=()=>new Promise(r=>{release=r})
const pending=directory.load()
await directory.select({...current,contextWindowTokens:16384})
release({result:{ok:true,value:{current,groups,failures:[],routable:true}}});await pending
assert.equal(directory.store.getSnapshot().current.contextWindowTokens,16384)
// Unmount/dispose: late failure cannot mutate the shared store.
const late=directory.load();directory.dispose();const snapshot=directory.store.getSnapshot()
release({result:{ok:true,value:{current,groups,failures:[],routable:true}}});await late
assert.equal(directory.store.getSnapshot(),snapshot)
console.log('model controls: RPC forwarding, persistence re-load, model limits, invalid input, transport errors, race/disposal passed')
// Use the actual bundled wire schemas, not a lookalike validator.
const connectionBundle=readFileSync(new URL('../ui/dist/plugins/@deepseek-ai/dsh-client-connection/client.js',import.meta.url),'utf8')
let connectionFactory
const sandbox={window:{__ModuleLoader__:{load(x){connectionFactory=x.factory}}},console,URL,AbortController,setTimeout,clearTimeout}
vm.runInNewContext(connectionBundle.replace('exports.AbstractApiClient = AbstractApiClient;', 'exports.testModelsSchema = sessionModelsValueSchema; exports.testSelectedSchema = sessionSelectModelValueSchema; exports.AbstractApiClient = AbstractApiClient;'), sandbox)
const wire=connectionFactory(id=>{if(id==='@deepseek-ai/cordis')return {Service:class{}};return {}})
const input={current,groups:[{id:'test',name:'Test',models:[{id:'large',name:'Large',contextWindow:131072,contextWindowSource:'provider_reported',contextWindowCapability:{providerLimit:{tokens:131072,source:'provider_reported'}},reasoning:{defaultEffort:'max',efforts:[{id:'max',name:'Max'}]}}]}],failures:[],routable:true}
const decoded=wire.testModelsSchema.parse(input)
assert.equal(decoded.current.contextWindowTokens,65536)
assert.equal(decoded.groups[0].models[0].contextWindow,131072)
assert.equal(decoded.groups[0].models[0].contextWindowSource,'provider_reported')
assert.equal(decoded.groups[0].models[0].contextWindowCapability.providerLimit.tokens,131072)
assert.equal(wire.testSelectedSchema.parse({selected:current}).selected.contextWindowTokens,65536)
assert.throws(()=>wire.testSelectedSchema.parse({selected:{...current,contextWindowTokens:-1}}))
console.log('actual bundled wire schemas preserve model capability and persisted selection')
// Boot metadata must identify exactly the bytes carried by Web and the desktop bundle.
const {createHash}=await import('node:crypto')
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url),'utf8'))
const html=readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8')
assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]),graph)
for(const id of ['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-ui-model-selection']){
 const bytes=readFileSync(new URL(`../ui/dist/plugins/${id}/client.js`,import.meta.url))
 assert.equal(graph.entries.find(e=>e.id===id).rev,createHash('sha256').update(bytes).digest('hex').slice(0,16))
}
console.log('boot graph and shipped model control module hashes match')
