// Real Cordis tracker/fiber integration over frozen/source Settings + Gateway.
// The fixture replaces only Host transport, not Service/Context/lifecycle.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
import {loadOwnedCordisRuntime,loadOwnedSnapshotRuntime} from './fixtures/owned-view-cordis-runtime.mjs'
const ui=fileURLToPath(new URL('../ui/',import.meta.url)),Core=loadOwnedCordisRuntime(),snapshot=loadOwnedSnapshotRuntime()
const rows=[{id:'@xharness/dsh-client-ui-settings',source:'src/modules/settings/index.ts'},{id:'@xharness/dsh-api-gateway',source:'src/modules/api-gateway/index.ts'},{id:'@xharness/dsh-client-connection',source:'src/modules/client-connection/index.ts'}]
const source=compileSourceModules(ui,rows)
function modules(implementation){
  const result={}
  const globals={console,Promise,Date,AbortController,AbortSignal,URL,Error,TypeError,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval,fetch,Response,Headers,Request,crypto:globalThis.crypto,location:{origin:'http://cordis-fixture.test'},window:{__ModuleLoader__:{load(row){result[row.id]=row.factory(name=>{
    if(name==='@xharness/cordis')return Core
    if(name==='@xharness/dsh-client-runtime/client')return snapshot
    throw Error('Unexpected external '+name)
  })}}}}
  for(const row of rows){
    const bytes=implementation==='source'?source.get(row.id).bytes.toString():readFileSync(new URL(`../ui/reference/master-a613970/plugins/${row.id}/client.js`,import.meta.url),'utf8')
    vm.runInNewContext(bytes,globals)
  }
  return result
}
const results=[]
for(const implementation of ['legacy','source']){
  const exported=modules(implementation),calls=[],events=[],root=new Core.Context(),ns={ns:'owned',schema:{type:'object',meta:{},dict:{selection:{type:'string',meta:{}}}},value:{selection:'first'},base:{},user:{},revision:1,applies:'live',secrets:[]}
  class Api extends exported['@xharness/dsh-client-connection'].AbstractApiClient{
    async doFetch(url,init){
      const request=JSON.parse(init.body);calls.push({method:request.method,payload:request.payload})
      let value
      if(request.method==='settings.describe')value={namespaces:[ns],writable:true,hasDocument:true}
      else if(request.method==='settings.mutate'){
        ns.value={selection:request.payload.ops[0].value};ns.revision++;value=ns
      }else throw Error(request.method)
      return new Response(JSON.stringify({type:'server-response',rpcId:request.rpcId,result:{ok:true,value}}),{headers:{'content-type':'application/json'}})
    }
  }
  const api=new Api(),rpcCalls=[],rpc={async call(path,endpoint,payload,signal){rpcCalls.push({path,endpoint,args:payload.args,aborted:signal.aborted});return{ok:true,value:{echo:payload.args.sessionId??'direct'}}}}
  const connectionDispose=root.provide('connection',{isLoopback:true,api,rpc})
  const typertDispose=root.provide('typert',{remotes:{register(contribution){events.push('mount:'+contribution.package);return()=>{events.push('unmount:'+contribution.package)}}},contexts:{getClient(name){return name==='Session'?{identity(ctx){return ctx.sessionId}}:undefined}}})
  exported['@xharness/dsh-api-gateway'].apply(root)
  exported['@xharness/dsh-client-ui-settings'].apply(root)
  await root.settingsScope.describe().ensure()
  const schema=root.settingsSchema
  for(const envelope of [ns.schema,{uid:1,refs:{1:{type:'object',meta:{},dict:{selection:2}},2:{type:'string',meta:{}}}}]){
    const live=schema.rehydrate(envelope);assert.equal(schema.validate(live,{selection:'valid'}),undefined);assert.match(schema.validate(live,{selection:7}),/string/)
  }
  const invalidEnvelopes=[null,[],{uid:1,refs:{}},{uid:1,refs:{1:{type:'object',dict:{selection:9},meta:{}}}}]
  // Frozen Schemastery historically tolerates some malformed constructor inputs.
  // The source-owned envelope boundary now rejects them; no arbitrary T is promised.
  if(implementation==='source')for(const bad of invalidEnvelopes)assert.throws(()=>schema.rehydrate(bad))
  const codec={mode:'strict',schema:{parse(value){if(typeof value!=='string')throw Error('expected string');return value}}}
  const resultCodec={mode:'strict',schema:{parse(value){if(!value||typeof value.echo!=='string')throw Error('bad result');return value}}}
  const contribution={package:'fixture',descriptors:[{namespace:'owned',method:'read',parameters:[],result:resultCodec,invocation:{kind:'context',context:'Session',wire:'sessionId',codec}}]}
  let oneCtx,twoCtx,oneScope,twoScope,oneEvents=0,twoEvents=0
  const one=root.plugin({name:'caller-one',inject:['settingsScope','remote','connection','typert'],async apply(ctx){oneCtx=ctx.extend({sessionId:'one'});oneScope=oneCtx.settingsScope.bind({namespace:'owned',decode:value=>typeof value?.selection==='string'?value:undefined});oneCtx.remote.$on('fixture',()=>oneEvents++);await oneCtx.remote.$mount(contribution)}})
  await one
  const two=root.plugin({name:'caller-two',inject:['settingsScope','remote','connection','typert'],apply(ctx){twoCtx=ctx.extend({sessionId:'two'});twoScope=twoCtx.settingsScope.bind({namespace:'owned'});twoCtx.remote.$on('fixture',()=>twoEvents++)}})
  await two
  let oneRead,twoRead
  const readOne=oneCtx.plugin({name:'one-namespaced-read',inject:['remote.owned'],async apply(ctx){oneRead=await ctx.remote.owned.read()}})
  const readTwo=twoCtx.plugin({name:'two-namespaced-read',inject:['remote.owned'],async apply(ctx){twoRead=await ctx.remote.owned.read()}})
  await readOne;await readTwo
  assert.deepEqual(JSON.parse(JSON.stringify(oneRead)),{ok:true,value:{echo:'one'}})
  assert.deepEqual(JSON.parse(JSON.stringify(twoRead)),{ok:true,value:{echo:'two'}})
  assert.deepEqual(rpcCalls.map(row=>row.args.sessionId),['one','two'],'namespace getter and method retain caller tracker')
  root.remote.$dispatch('fixture',[]);assert.equal(oneEvents,1);assert.equal(twoEvents,1)
  await oneScope.set('selection','from-one');assert.equal(twoScope.getSnapshot().value.selection,'from-one')
  await one.dispose()
  root.remote.$dispatch('fixture',[]);assert.equal(oneEvents,1);assert.equal(twoEvents,2,'caller-one cleanup does not retire caller-two registration')
  const writes=calls.filter(row=>row.method==='settings.mutate').length
  await oneScope.set('selection','after-dispose');assert.equal(calls.filter(row=>row.method==='settings.mutate').length,writes,'disposed caller scope cannot write')
  await twoScope.set('selection','from-two');assert.equal(calls.filter(row=>row.method==='settings.mutate').length,writes+1)
  assert.equal(root.get('remote.owned'),undefined,'contribution removed with calling fiber')
  assert.ok(events.includes('unmount:fixture'))
  const isolated=root.isolate('connection');isolated.provide('connection',{isLoopback:false,api,rpc})
  let memoryScope
  const three=isolated.plugin({name:'caller-memory',inject:['settingsScope','remote','connection','typert'],apply(ctx){memoryScope=ctx.settingsScope.bind({namespace:'owned'})}})
  await three;assert.equal(memoryScope.getSnapshot().mode,'memory','bind uses caller connection isolation, not saved ownerCtx');await three.dispose()
  connectionDispose();let missing=false
  try{root.settingsScope.bind({namespace:'owned'})}catch{missing=true}assert.equal(missing,true)
  await two.dispose();typertDispose();await root.fiber.dispose()
  results.push({implementation,callerIds:rpcCalls.map(row=>row.args.sessionId),oneEvents,twoEvents,writes:calls.filter(row=>row.method==='settings.mutate').length,events,memoryMode:memoryScope.getSnapshot().mode})
}
assert.deepEqual({...results[0],implementation:undefined},{...results[1],implementation:undefined})
console.log(JSON.stringify({realCordisVendor:true,trueDynamicReceiver:true,callerFiberCleanup:true,connectionIsolationAndUnload:true,actualDirectWireDecoder:true,validAndInvalidSchemaEnvelopes:true,results}))
