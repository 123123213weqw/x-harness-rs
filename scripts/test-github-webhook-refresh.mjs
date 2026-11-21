/** Exact owned source contracts: typed invalidation only, no prompt/tool surface. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
const outputs=compileSourceModules('ui',[{id:'events',source:'src/modules/workspace/project-events.ts'},{id:'request',source:'src/modules/workspace/project-github.ts'},{id:'connection',source:'src/modules/client-connection/controller.ts'}])
function load(id){let row;vm.runInNewContext(outputs.get(id).bytes.toString(),{window:{__ModuleLoader__:{load:r=>row=r}},AbortController,AbortSignal,console,setTimeout,clearTimeout});return row.factory(name=>{throw Error(name)})}
const {ProjectEventFeed}=load('events'),{ProjectStatusRequest,parseProjectGitHub}=load('request'),{ConnectionController}=load('connection')
const flush=()=>new Promise(resolve=>setTimeout(resolve,0)),good={kind:'no_pr',ci:'none',repositoryId:'R_project7'}
test('strict metadata envelope cannot become a command, task, prompt or arbitrary event',()=>{
 const feed=new ProjectEventFeed(),generation={},seen=[];feed.subscribe(v=>seen.push(v))
 for(const raw of [{task:'run'}, {repositoryIds:['R_project7'],reset:true,connected:true,prompt:'execute'}, {repositoryIds:['bad'],reset:false,connected:true},{repositoryIds:['R_project7','R_project7'],reset:false,connected:true},{repositoryIds:['R_project7'],reset:false,connected:false}])assert.equal(feed.receive(raw,generation),false)
 assert.equal(feed.receive({repositoryIds:['R_project7'],reset:false,connected:true},undefined),false)
 assert.equal(seen.length,0);assert.equal(feed.receive({repositoryIds:['R_project7'],reset:false,connected:true},generation),true);assert.equal(seen.length,1);assert.equal(seen[0].generation,generation);assert.equal(feed.current().reset,false);assert.equal(feed.current().repositoryIds.length,0,'late mounts never replay old invalidation')
 feed.reset();assert.equal(feed.current(),undefined);feed.dispose();assert.equal(feed.receive({repositoryIds:[],reset:true,connected:true},generation),false)
})
test('connection availability is generation scoped and disconnected repeats are coalesced',()=>{
 const feed=new ProjectEventFeed(),g1={},g2={},seen=[];const off=feed.subscribe(v=>seen.push(v))
 const down={repositoryIds:[],reset:false,connected:false};feed.receive(down,g1);feed.receive(down,g1);assert.equal(seen.length,1);feed.receive(down,g2);assert.equal(seen.length,2);off();feed.receive({repositoryIds:['R_project7'],reset:false,connected:true},g2);assert.equal(seen.length,2)
})
test('repo identity survives no-PR state and is strictly validated',()=>{
 assert.equal(parseProjectGitHub(good).repositoryId,'R_project7');assert.throws(()=>parseProjectGitHub({...good,repositoryId:'bad\n'}));assert.equal(parseProjectGitHub({kind:'unsupported',ci:'unknown'}).repositoryId,undefined)
})
test('one hundred invalidations during a read make one fresh follow-up, not a lost event or storm',async()=>{
 let calls=0;const resolves=[],signals=[],published=[];const request=new ProjectStatusRequest(async(_id,signal)=>{calls++;signals.push(signal);return await new Promise(done=>resolves.push(done))},'workspace');const publish=(...row)=>published.push(row)
 const first=request.refresh(publish);for(let i=0;i<100;i++)request.invalidate(publish);assert.equal(calls,1);assert.equal(signals[0].aborted,true)
 resolves[0]({kind:'no_pr',ci:'none'});await first;assert.equal(calls,2);resolves[1](good);await flush();assert.equal(published.filter(v=>v[0]).length,1);assert.equal(published.at(-1)[0].repositoryId,'R_project7');request.dispose()
})
test('disconnect and row disposal cancel pending work without stale result or hidden follow-up',async()=>{
 for(const stop of ['cancel','dispose']){
  let done,calls=0;const rows=[];const request=new ProjectStatusRequest(async()=>{calls++;return await new Promise(resolve=>done=resolve)},'w');const first=request.refresh((...v)=>rows.push(v));request.invalidate((...v)=>rows.push(v));request[stop]();done(good);await first;await flush();assert.equal(calls,1);assert.equal(rows.filter(v=>v[0]).length,0);request.dispose()
 }
})
test('cancel releases the query slot immediately and reports whether it cancelled work',async()=>{
 let calls=0;const resolves=[],rows=[];const request=new ProjectStatusRequest(async()=>{calls++;return await new Promise(done=>resolves.push(done))},'w')
 const publish=(...v)=>rows.push(v)
 assert.equal(request.cancel(),false,'an idle unsupported row need not become an error')
 const old=request.refresh(publish)
 assert.equal(request.cancel(),true)
 const manual=request.refresh(publish)
 assert.equal(calls,2,'manual refresh must not wait for the cancelled transport to settle')
 resolves[1](good);await manual
 resolves[0]({...good,repositoryId:'R_stale999'});await old
 assert.deepEqual(rows.filter(v=>v[0]).map(v=>v[0].repositoryId),['R_project7'])
 assert.equal(request.cancel(),false)
 request.dispose()
})
test('a cancelled query finally cannot consume a newer query queued invalidation',async()=>{
 let calls=0;const resolves=[],rows=[];const request=new ProjectStatusRequest(async()=>{calls++;return await new Promise(done=>resolves.push(done))},'w')
 const publish=(...v)=>rows.push(v)
 const old=request.refresh(publish);request.cancel()
 const manual=request.refresh(publish)
 assert.equal(calls,2)
 for(let i=0;i<100;i++)request.invalidate(publish)
 resolves[0](good);await old
 assert.equal(calls,2,'old completion cannot start or consume newer queued work')
 resolves[1](good);await manual
 assert.equal(calls,3,'the newer owner must still start its one coalesced follow-up')
 resolves[2](good);await flush()
 assert.equal(rows.filter(v=>v[0]).length,1)
 request.dispose()
})
test('late cancelled query rejection cannot erase a successful manual refresh',async()=>{
 let rejectOld;let calls=0;const rows=[];const request=new ProjectStatusRequest(async()=>++calls===1?await new Promise((_done,reject)=>rejectOld=reject):good,'w')
 const publish=(...v)=>rows.push(v)
 const old=request.refresh(publish);request.cancel();await request.refresh(publish)
 rejectOld(Error('late cancelled transport failure'));await old
 assert.equal(calls,2);assert.equal(rows.at(-1)[0].repositoryId,'R_project7');assert.equal(rows.at(-1)[2],false)
 assert.equal(rows.filter(v=>v[1]).length,0)
 request.dispose()
})
function channel(){const queued=[];let wait,closed=false;return{push:value=>{if(wait){const done=wait;wait=undefined;done({done:false,value})}else queued.push(value)},end:()=>{closed=true;wait?.({done:true});wait=undefined},[Symbol.asyncIterator](){return this},next(){if(queued.length)return Promise.resolve({done:false,value:queued.shift()});if(closed)return Promise.resolve({done:true});return new Promise(resolve=>wait=resolve)},return(){closed=true;return Promise.resolve({done:true})}}}
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,2))}assert.fail('controlled connection did not converge')}
test('late Host and mux frames from an aborted generation never reach the new consumer',async()=>{
 const mux=[],host=[],seen=[],connected=[];const api={events:{mux:(_p,_signal,open)=>{const c=channel();mux.push(c);open();return c},host:(_p,_signal,open)=>{const c=channel();host.push(c);open();return c}},host:{describe:async()=>({result:{ok:true,value:{home:'/home'}}})}}
 const controller=new ConnectionController(api,{onHostEnvelope:x=>seen.push(x),onMuxEnvelope:x=>seen.push(x),onConnected:x=>connected.push(x)},{backoffBaseMs:1,backoffMaxMs:1,streamOpenTimeoutMs:50})
 controller.start();try{
  await until(()=>connected.length===1);mux[0].end();await until(()=>connected.length===2)
  host[0].push({payload:{type:'host/remote-event',event:'github/project-status-invalidated',args:[]}});await flush();assert.equal(seen.length,0,'old abort-ignoring carrier is fenced')
  host[1].push({payload:{type:'host/remote-event',event:'github/project-status-invalidated',args:[]}});await until(()=>seen.length===1)
  controller.stop();mux[1].push({payload:{type:'session/event'}});await flush();assert.equal(seen.length,1,'stopped generation cannot deliver late mux data')
 }finally{controller.stop();for(const c of [...mux,...host])c.end()}
})
