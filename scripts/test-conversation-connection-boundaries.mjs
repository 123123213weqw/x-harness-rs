/** Direct protocol extensions + open carrier/surface rules of the actual strict factory. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
import {loadOwnedCordisRuntime} from './fixtures/owned-view-cordis-runtime.mjs'
import {exposeModuleUnit} from './fixtures/module-unit-scope.mjs'
const id='@xharness/dsh-client-connection',source=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id,source:'src/modules/client-connection/index.ts'}]).get(id).bytes.toString(),frozen=readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8')
function evaluate(bytes,fixture=false,externals={}){let row;const context={window:{location:{origin:'http://connection.test',hostname:'connection.test',search:fixture?'?fixture=1':''},__ModuleLoader__:{load:value=>row=value}},location:{origin:'http://connection.test',hostname:'connection.test',search:fixture?'?fixture=1':''},console,AbortController,AbortSignal,URL,URLSearchParams,Date,fetch,Response,Headers,Request,crypto:globalThis.crypto,structuredClone,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval};vm.runInNewContext(bytes,context);return row.factory(name=>{if(name in externals)return externals[name];throw Error(name)})}
const apis=[evaluate(frozen),evaluate(source)],json=value=>JSON.parse(JSON.stringify(value))
const surfaceName='contracts/core/session/surface',names=['isSurfaceEvent','isAppendSurfaceEvent','isReplacementSurfaceEvent','deriveEventMessage','foldSurface','SurfaceManager']
const frozenMarkers=evaluate(readFileSync('ui/reference/master-a613970/plugins/@xharness/dsh-client-runtime/client.js','utf8').replace('return module.exports;','Object.assign(exports,{isSurfaceEvent,isAppendSurfaceEvent,isReplacementSurfaceEvent});return module.exports;'),false,{'@xharness/cordis':loadOwnedCordisRuntime(),'@xharness/dsh-client-ui-slots':{}})
const surfaceApis=[frozen,source].map((bytes,index)=>Object.fromEntries(names.filter(name=>index===1||name!=='SurfaceManager').map(name=>[name,index===0&&name.startsWith('is')?frozenMarkers[name]:evaluate(exposeModuleUnit(bytes,'client-connection',surfaceName,name))[name]])))
const raw=(type,data,seq,surfaceOp='append',extra={})=>({type,data,seq,time:1000+seq,surfaceOp,...extra})
const message=(id,role='user',content=[{type:'text',text:'kept'}])=>({id,role,content,source:{kind:'foreign-provider',extension:{keep:true}},foreign:{opaque:'value'}})

test('latest-native archive metadata stays absent on old payloads and preserves all current protocol fields when present',async()=>{
 const [old,next]=apis,values=[{items:[],archivedSessionIds:['s']},{items:[],archivedSessionIds:['s','s2'],archivedSessions:[{sessionId:'s',title:'Archived title',updatedAt:1000},{sessionId:'s2',title:null,updatedAt:0}]}]
 async function read(api,value){class Carrier extends api.AbstractApiClient{async doFetch(_url,init){const req=JSON.parse(init.body);return new Response(JSON.stringify({type:'server-response',rpcId:req.rpcId,result:{ok:true,value}}),{headers:{'content-type':'application/json'}})}}return(await new Carrier().workspace.list({})).result.value}
 const a=await read(old,values[0]),b=await read(next,values[0]);assert.deepEqual(json(b),json(a));assert.equal(Object.hasOwn(b,'archivedSessions'),false,'missing metadata is not fabricated as []')
 assert.deepEqual(json(await read(next,values[1])),values[1],'actual native metadata, nullable title and zero timestamp survive typed decoding')
 await assert.rejects(read(next,{...values[1],archivedSessions:[{sessionId:'s',title:7,updatedAt:0}]}),/Invalid input/)
 for(const bytes of[frozen,source]){const api=evaluate(bytes,true),provided={};api.apply({provide:(name,value)=>provided[name]=value,effect:fn=>fn()});const listed=(await provided.connection.api.workspace.list({})).result.value;assert.equal(Object.hasOwn(listed,'archivedSessions'),false,'unchanged fixture does not invent new native fields')}
})

test('frozen/source in-process fork carrier retains parent/origin in session list and host frames without pretending the HTTP schema changed',async()=>{
 for(const bytes of[frozen,source]){
  const provided={};evaluate(bytes,true).apply({provide:(name,value)=>provided[name]=value});const api=provided.connection.api
  const history=(await api.sessions.history({sessionId:'fx-alpha',maxMessages:1000})).result.value.events;const before=history.find(entry=>entry.event.type==='user/message'&&entry.event.data.source.kind==='user').event.seq
  const abort=new AbortController(),stream=api.events.host({},abort.signal)[Symbol.asyncIterator](),frame=stream.next()
  const fork=(await api.sessions.fork({sessionId:'fx-alpha',beforeUserSeq:before})).result.value.sessionId
  const list=(await api.sessions.list({})).result.value.items,row=list.find(row=>row.sessionId===fork);assert.equal(row.origin,'fork');assert.equal(row.parentSessionId,'fx-alpha');assert.equal(row.blank,true)
  const added=(await frame).value.payload;assert.equal(added.type,'host/session-added');assert.equal(added.origin,'fork');assert.equal(added.sessionId,fork);assert.equal(added.parentSessionId,'fx-alpha');abort.abort();await stream.return()
 }
})

test('fixture generic RPC routes root capabilities before session-only decoders and rejects unsupported calls explicitly',async()=>{
 const results=[]
 for(const bytes of[frozen,source]){
  const provided={};evaluate(bytes,true).apply({provide:(name,value)=>provided[name]=value});const rpc=provided.connection.rpc
  const rootErrors=[]
  for(const [channel,endpoint,payload]of[
   ['/api','dynamicCordisRunner/syncInspectManifest',{args:{providers:[{id:'theme',description:'actual root manifest',methods:[]}]}}],
   ['/api','future/root-capability',{args:{configuration:{opaque:true}}}],
   ['/rpc','dynamicCordisRunner/syncInspectManifest',{args:{providers:[]}}],
  ]){
   await assert.rejects(async()=>rpc.call(channel,endpoint,payload),error=>{rootErrors.push(error.message);assert.match(error.message,/fixture connection RPC (?:endpoint|channel).*unavailable/);assert.doesNotMatch(error.message,/agentId|Invalid input/);return true})
  }
  const list=await rpc.call('/api','commands/list',{args:{agentId:'fx-alpha',line:7,query:false,images:{foreign:true}}})
  assert.equal(list.ok,true,'only consumed fields of the owned endpoint are decoded')
  const execute=await rpc.call('/api','commands/execute',{args:{agentId:'fx-alpha',line:'/not-a-command',images:null}})
  const files=await rpc.call('/api','fileReferences/list',{args:{agentId:'fx-alpha',query:null}})
  assert.equal(files.ok,true);assert.ok(files.value.length>0,'legacy nullish query remains an empty search')
  results.push({rootErrors,list:json(list),execute:json(execute),files:json(files)})
 }
 assert.deepEqual(results[1],results[0],'erased root RPC and legitimate scoped calls retain the immutable fixture ABI')
 const provided={};evaluate(source,true).apply({provide:(name,value)=>provided[name]=value});const rpc=provided.connection.rpc
 for(const[endpoint,args]of[
  ['commands/list',{agentId:42}],['commands/execute',{agentId:'fx-alpha',line:12}],
  ['commands/execute',{agentId:'fx-alpha',line:'/echo',images:'invalid'}],
  ['fileReferences/list',{agentId:'fx-alpha',query:{bad:true}}],
  ['goals/create',{agentId:'fx-alpha',request:{objective:false}}],
  ['goals/edit',{agentId:'fx-alpha',ref:{id:'goal',revision:'bad'},request:{}}],
 ])await assert.rejects(async()=>rpc.call('/api',endpoint,{args}),/Invalid input/,'malformed consumed fields are not silently ignored')
})

test('latest-native direct unarchive/delete helpers preserve established generic RPC endpoint/payload/abort/correlation ABI',async()=>{
 const [old,next]=apis;assert.equal(new old.AbstractApiClient().workspace.unarchiveSession,undefined,'frozen direct helper is absent; native endpoint parity is not falsely claimed')
 const calls=[];let malformed=false
 class Carrier extends next.AbstractApiClient{async doFetch(url,init){const req=JSON.parse(init.body);calls.push({url:String(url),request:req,signal:init.signal});const value=req.method==='workspace.unarchiveSession'?{archivedSessionIds:['remaining']}:{deleted:malformed?'yes':true};return new Response(JSON.stringify({type:'server-response',rpcId:req.rpcId,result:{ok:true,value}}),{headers:{'content-type':'application/json'}})}}
 const client=new Carrier(),abort=new AbortController();assert.deepEqual(json((await client.workspace.unarchiveSession({sessionId:'archived'},abort.signal)).result),{ok:true,value:{archivedSessionIds:['remaining']}});assert.deepEqual(json((await client.sessions.delete({sessionId:'stopped'},abort.signal)).result),{ok:true,value:{deleted:true}})
 assert.deepEqual(calls.map(row=>[row.request.method,row.request.payload,row.signal.aborted]),[['workspace.unarchiveSession',{sessionId:'archived'},false],['session.delete',{sessionId:'stopped'},false]]);assert.ok(calls[0].url.endsWith('/api/workspace.unarchiveSession'));assert.ok(calls[1].url.endsWith('/api/session.delete'));abort.abort();assert.equal(calls.every(row=>row.signal.aborted),true,'composed request deadlines preserve caller abort');malformed=true;await assert.rejects(client.sessions.delete({sessionId:'stopped'}),/Invalid input/)
 const protocol=readFileSync('crates/xharness-api/src/protocol.rs','utf8');assert.match(protocol,/WorkspaceUnarchiveSession\s*=>\s*\(SessionIdParams,\s*ArchivedSessionsResponse\)/);assert.match(protocol,/SessionDelete\s*=>\s*\(SessionIdParams,\s*DeletedResponse\)/)
})

test('open carrier projects legitimate full messages by identity including unknown content tags, empty assistant and foreign fields',()=>{
 const corpus=[raw('user/message',message('u','user',[{type:'future/attachment',wire:{opaque:[1,2]}}]),0),raw('assistant/message',{message:message('a','assistant')},1),raw('assistant/message',{message:message('a','assistant',[])},2),raw('tool/result',{message:message('t','assistant',[{type:'tool-result',content:[{type:'foreign/tool-result',opaque:true}]}])},3),raw('foreign/plugin',{unknown:true},4,undefined)]
 for(const event of corpus){const values=surfaceApis.map(api=>api.deriveEventMessage(event));assert.deepEqual(json(values[1]),json(values[0]));for(let i=0;i<values.length;i++)assert.equal(values[i],event.type==='user/message'?event.data:event.type==='assistant/message'&&event.data.message.content.length===0||event.type==='foreign/plugin'?null:event.data.message)}
 for(const api of surfaceApis)for(const marker of[undefined,'append',null,{op:'replace',start:0,end:1}])for(const type of['user/message','assistant/message','tool/result','foreign/plugin']){const event={type,surfaceOp:marker};assert.equal(api.isSurfaceEvent(event),type!=='foreign/plugin'&&marker!==undefined);assert.equal(api.isAppendSurfaceEvent(event),type!=='foreign/plugin'&&marker==='append');assert.equal(api.isReplacementSurfaceEvent(event),type!=='foreign/plugin'&&marker!==undefined&&marker!=='append')}
 for(const event of[raw('user/message',null,0),raw('assistant/message',{message:{content:[]}},1)])assert.equal(surfaceApis[1].deriveEventMessage(event),null,'unknown boundary does not promise an unvalidated Message')
})

test('surface folding preserves replacement/provenance errors and atomic incremental admission of unknown carriers',()=>{
 const corpus=[raw('user/message',message('u'),0),{type:'foreign/log',data:{keep:true},seq:1,time:1001},raw('assistant/message',{message:message('a','assistant')},2),raw('user/message',message('checkpoint'),3,{op:'replace',start:0,end:2},{sourceEventSeqs:[0,2]})]
 for(const api of surfaceApis)assert.deepEqual(json(api.foldSurface(corpus)),{nodes:[3],replacements:[{seq:3,start:0,end:2,shadowedSeqs:[0,2]}]});{const api=surfaceApis[1],log=corpus.slice(0,3),manager=new api.SurfaceManager(log);assert.deepEqual(json(manager.nodes),[0,2]);const invalid={...corpus[3],sourceEventSeqs:[0]};assert.throws(()=>manager.validateNext(invalid),/include every shadowed/);assert.deepEqual(json(manager.nodes),[0,2]);assert.equal(manager.replaceGeneration,0);manager.validateNext(corpus[3]);log.push(corpus[3]);assert.deepEqual(json(manager.nodes),[3]);assert.equal(manager.replaceGeneration,1)}
 const invalids=[[raw('foreign/log',{},0)],[{...raw('user/message',message('u'),0),surfaceOp:undefined}],[raw('user/message',message('u'),1)],[raw('user/message',message('u'),0),raw('user/message',message('v'),1,{op:'replace',start:0,end:0},{sourceEventSeqs:[0,0]})]]
 for(const events of invalids){const errors=surfaceApis.map(api=>{try{api.foldSurface(events);return null}catch(error){return error.message}});assert.equal(errors[1],errors[0]);assert.ok(errors[0])}
})

test('delete acknowledgement retains owned-session ids while old delete responses stay compatible',async()=>{
 const api=apis[1];let value={deleted:true,deletedSessionIds:['root','child']}
 class Carrier extends api.AbstractApiClient{async doFetch(_url,init){const req=JSON.parse(init.body);return new Response(JSON.stringify({type:'server-response',rpcId:req.rpcId,result:{ok:true,value}}),{headers:{'content-type':'application/json'}})}}
 const client=new Carrier();assert.deepEqual(json((await client.sessions.delete({sessionId:'root'})).result.value),value)
 value={deleted:true};assert.deepEqual(json((await client.sessions.delete({sessionId:'root'})).result.value),value)
 value={deleted:true,deletedSessionIds:[3]};await assert.rejects(client.sessions.delete({sessionId:'root'}),/Invalid input/)
})
