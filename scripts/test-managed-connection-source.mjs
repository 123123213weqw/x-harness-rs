import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
const output=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id:'managed-connection-test',source:'src/modules/settings-models/managed-connection.ts'}])
function fixture(){
 let registered, timer, wake, unlistened=0
 vm.runInNewContext(output.get('managed-connection-test').bytes.toString(),{window:{__ModuleLoader__:{load:r=>registered=r}},setInterval:fn=>{timer=fn;return 1},clearInterval:()=>{timer=null}})
 const {ManagedConnection}=registered.factory(()=>{throw Error('no runtime dependency expected')})
 const calls=[];let responses=[],failSave=false
 const ok=value=>({result:{ok:true,value}})
 const ns={ns:'llm-pi-ai',revision:7,value:{providers:{}}}
 const describe={ensure:async()=>{},getSnapshot:()=>({status:'ready',view:{writable:true,namespaces:[ns]}}),acceptView:()=>{}}
 const api={credentials:{describe:async()=>ok({credentials:{}}),set:async p=>{calls.push(['save',p.ref]);if(failSave)throw Error();return ok({})},unset:async()=>ok({})},settings:{mutate:async p=>{calls.push(['profile',p.expectedRevision]);return ok(ns)}}}
 const bridge={core:{invoke:async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='desktop_account_status')return {};if(cmd==='desktop_account_start')return {userCode:'ABCDEF012345',verificationUri:'https://engine.xxdevs.com/account'};if(cmd==='desktop_account_poll'){const r=responses.shift()??{status:'pending'};if(typeof r==='string')throw r;return r}}},event:{listen:async(_name,fn)=>{wake=fn;return()=>{unlistened++}}}}
 const c=new ManagedConnection(api,describe)
 return {c,bridge,calls,setResponses:v=>{responses=v},failSave:v=>{failSave=v},wake:()=>wake(),disposeCount:()=>unlistened,hasTimer:()=>!!timer}
}
const access={status:'authorized',accessToken:'private-fixture',baseURL:'https://engine.xxdevs.com/api/inference/v1',models:[{id:'fixture',contextWindow:1000,maxTokens:100}]}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
test('login opens browser and continues after section leaves; wake saves once, no secrets in UI snapshot',async()=>{
 const f=fixture(),dispose=f.c.attach(f.bridge);await flush();await f.c.start()
 assert.deepEqual(f.calls.slice(-2).map(r=>r[0]),['desktop_account_start','desktop_account_open'])
 // There is no mounted React view: lifecycle stays owned by the plugin.
 f.setResponses([access]);f.wake();await flush()
 assert.equal(f.c.getSnapshot().connected,true);assert.equal(f.c.getSnapshot().flow,null)
 assert.ok(!JSON.stringify(f.c.getSnapshot()).includes(access.accessToken))
 assert.equal(f.calls.filter(r=>r[0]==='save').length,1)
 f.wake();await flush();assert.equal(f.calls.filter(r=>r[0]==='save').length,1)
 dispose();await flush();assert.equal(f.hasTimer(),false);assert.equal(f.disposeCount(),1)
})
test('network loss keeps polling; failed local credential save needs explicit retry',async()=>{
 const f=fixture(),dispose=f.c.attach(f.bridge);await flush();await f.c.start()
 f.setResponses(['account_network_unavailable',access,access]);await f.c.tick()
 assert.equal(f.c.getSnapshot().retry,false)
 f.failSave(true);await f.c.tick();assert.equal(f.c.getSnapshot().retry,true)
 const count=f.calls.length;await f.c.tick();assert.equal(f.calls.length,count)
 f.failSave(false);f.c.retry();await flush();assert.equal(f.c.getSnapshot().connected,true)
 dispose()
})
test('ordinary Web does not authenticate; pending throttles silently, expired flow can restart',async()=>{
 const f=fixture(),webdispose=f.c.attach(undefined);await flush();await f.c.start();assert.equal(f.c.getSnapshot().native,false);assert.equal(f.calls.length,0);webdispose()
 const g=fixture(),dispose=g.c.attach(g.bridge);await flush();await g.c.start()
 g.setResponses(['account_poll_pending','account_connection_expired']);await g.c.tick();assert.equal(g.c.getSnapshot().error,false)
 await g.c.tick();assert.equal(g.c.getSnapshot().flow,null);assert.equal(g.c.getSnapshot().error,true)
 await g.c.start();assert.ok(g.c.getSnapshot().flow);dispose()
})
