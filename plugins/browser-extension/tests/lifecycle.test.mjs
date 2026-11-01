import test from 'node:test'
import assert from 'node:assert/strict'
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function event(){const callbacks=[];return{addListener:fn=>callbacks.push(fn),emit(...args){for(const fn of callbacks)fn(...args)}}}
async function fixture({saved=[],enabled=false}={}){
 const local={autoConnect:enabled},session={bindings:saved},alarms=new Map(),alarmEvent=event();
 const storage=data=>({async setAccessLevel(){},async get(){return structuredClone(data)},async set(value){Object.assign(data,structuredClone(value))}})
 const native={onDisconnect:event(),onMessage:event(),messages:[],postMessage(value){this.messages.push(value)},disconnect(){this.onDisconnect.emit()}}
 const onMessage=event(),removed=event(),detached=event(),updated=event(),permissions=event(),calls=[]
 let attach=async()=>{},dispatch=async()=>({}),contains=async()=>true
 globalThis.chrome={storage:{local:storage(local),session:storage(session)},alarms:{onAlarm:alarmEvent,async create(name,info){alarms.set(name,info)},async clear(name){alarms.delete(name)}},runtime:{onStartup:event(),id:'test-id',getURL:path=>'chrome-extension://test-id/'+path,connectNative:()=>native,onMessage},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},permissions:{contains:()=>contains(),onRemoved:permissions},tabs:{get:async target=>({id:target,url:'https://example.test/',title:'Test',active:false}),query:async()=>[{id:1,url:'https://example.test/',title:'Test',active:false}],onRemoved:removed,onUpdated:updated},debugger:{attach:async(...args)=>attach(...args),detach:async()=>{},sendCommand:async(target,method,params)=>{calls.push({method,params});return dispatch(target,method,params)},onDetach:detached},scripting:{executeScript:async()=>[{result:{x:30,y:30}}]}}
 await import('../dist/extension/background.js?test='+crypto.randomUUID())
 const popup=action=>new Promise(resolve=>onMessage.emit(action,{id:'test-id',url:'chrome-extension://test-id/popup.html'},resolve))
 await popup({action:'connect'});native.onMessage.emit({type:'ready',version:1});native.onMessage.emit({type:'client',clientId:'client-a',contextId:'a'.repeat(64),contextLabel:'Conversation A'});native.onMessage.emit({type:'client',clientId:'client-b',contextId:'b'.repeat(64),contextLabel:'Conversation B'})
 return{native,calls,popup,local,session,alarms,alarmEvent,updated,setAttach(fn){attach=fn},setPermissions(fn){contains=fn},setDispatch(fn){dispatch=fn},permissionRemoved(){permissions.emit({origins:['https://example.test/*']})},command(requestId,command,clientId='client-a'){native.onMessage.emit({type:'command',clientId,requestId,command})},async settle(){for(let i=0;i<10;i++)await tick()},async close(){await popup({action:'disconnect'})}}
}
test('stopping during an awaited grant cannot resurrect permission',async()=>{
 const f=await fixture();let release;f.setAttach(()=>new Promise(resolve=>release=resolve))
 try{const granting=f.popup({action:'grant',tabId:1,clientId:'client-a'});await tick();await f.popup({action:'stop'});release();assert.equal((await granting).ok,false);assert.deepEqual((await f.popup({action:'state'})).grants,[])}finally{await f.close()}
})
test('exclusive tab ownership includes in-progress authorizations',async()=>{
 const f=await fixture();let release;f.setAttach(()=>new Promise(resolve=>release=resolve))
 try{const first=f.popup({action:'grant',tabId:1,clientId:'client-a'});await tick();assert.equal((await f.popup({action:'grant',tabId:1,clientId:'client-b'})).ok,false);release();assert.equal((await first).ok,true);assert.equal((await f.popup({action:'state'})).grants[0].clientId,'client-a')}finally{await f.close()}
})
test('queued effects cannot borrow a newly granted lease after stop',async()=>{
 const f=await fixture();let release;f.setDispatch((_target,method,params)=>method==='Input.dispatchKeyEvent'&&params.type==='keyDown'?new Promise(resolve=>release=resolve):Promise.resolve({}))
 try{
  await f.popup({action:'grant',tabId:1,clientId:'client-a'})
  f.command('one',{action:'press',tabId:1,key:'Enter'});await f.settle();f.command('two',{action:'press',tabId:1,key:'Enter'})
  await f.popup({action:'stop'});assert.equal((await f.popup({action:'grant',tabId:1,clientId:'client-a'})).ok,false);release({});await f.settle();assert.equal((await f.popup({action:'grant',tabId:1,clientId:'client-a'})).ok,true)
  assert.equal(f.calls.filter(call=>call.params.type==='keyDown').length,1)
  const replies=f.native.messages.filter(message=>message.type==='result');assert.equal(replies.length,2)
  assert.equal(replies.find(message=>message.requestId==='one').result.outcome,'possibly-applied')
  assert.equal(replies.find(message=>message.requestId==='two').result.outcome,'not-started')
 }finally{await f.close()}
})
test('unpaired and foreign-client requests never acquire later user authorization',async()=>{
 const f=await fixture()
 try{
  f.command('no-grant',{action:'press',tabId:1,key:'Enter'});await f.popup({action:'grant',tabId:1,clientId:'client-a'})
  f.command('foreign',{action:'press',tabId:1,key:'Enter'},'client-b');await f.settle()
  assert.equal(f.calls.length,0);assert.equal(f.native.messages.filter(message=>message.type==='result'&&message.result.ok===false).length,2)
 }finally{await f.close()}
})
test('host-permission removal and native disconnect revoke every grant',async()=>{
 const f=await fixture()
 try{
  await f.popup({action:'grant',tabId:1,clientId:'client-a'});f.permissionRemoved();await f.settle();assert.deepEqual((await f.popup({action:'state'})).grants,[])
  await f.popup({action:'grant',tabId:1,clientId:'client-a'});f.native.onDisconnect.emit();await f.settle()
  const state=await f.popup({action:'state'});assert.equal(state.connected,false);assert.deepEqual(state.grants,[]);assert.deepEqual(state.clients,[])
 }finally{await f.close()}
})
test('foreign page messages cannot grant browser authority',async()=>{
 const f=await fixture();let replied=false
 try{globalThis.chrome.runtime.onMessage.emit({action:'grant',tabId:1,clientId:'client-a'},{id:'test-id',url:'https://example.test/'},()=>replied=true);await f.settle();assert.equal(replied,false);assert.deepEqual((await f.popup({action:'state'})).grants,[])}finally{await f.close()}
})

test('stop wins even while the initial host-permission lookup is pending',async()=>{
 const f=await fixture();let release,attached=0;f.setPermissions(()=>new Promise(resolve=>release=resolve));f.setAttach(async()=>{attached++})
 try{const pending=f.popup({action:'grant',tabId:1,clientId:'client-a'});await tick();await f.popup({action:'stop'});release(true);assert.equal((await pending).ok,false);assert.equal(attached,0);assert.deepEqual((await f.popup({action:'state'})).grants,[])}finally{await f.close()}
})

test('same Host context restores its exact tab after MCP recreation without popup pairing',async()=>{
 const f=await fixture()
 try{
  await f.popup({action:'grant',tabId:1,clientId:'client-a'})
  f.native.onMessage.emit({type:'clientGone',clientId:'client-a'});await f.settle()
  assert.equal((await f.popup({action:'state'})).grants.length,0)
  f.native.onMessage.emit({type:'client',clientId:'replacement',contextId:'a'.repeat(64),contextLabel:'Conversation A'});await f.settle()
  assert.equal((await f.popup({action:'state'})).grants[0].clientId,'replacement')
  assert.equal(f.session.bindings[0].contextId,'a'.repeat(64))
  assert.equal(f.local.autoConnect,true)
 }finally{await f.close()}
})
test('a foreign context cannot inherit saved tabs; explicit stop persists revocation',async()=>{
 const f=await fixture()
 try{
  await f.popup({action:'grant',tabId:1,clientId:'client-a'})
  await f.popup({action:'stop'})
  f.native.onMessage.emit({type:'clientGone',clientId:'client-a'})
  f.native.onMessage.emit({type:'client',clientId:'replacement',contextId:'a'.repeat(64),contextLabel:'Conversation A'});await f.settle()
  assert.equal((await f.popup({action:'state'})).grants.length,0)
  assert.deepEqual(f.session.bindings,[])
 }finally{await f.close()}
})
test('duplicate context is ambiguous, revokes ownership and dispatches no effect',async()=>{
 const f=await fixture()
 try{
  await f.popup({action:'grant',tabId:1,clientId:'client-a'})
  f.native.onMessage.emit({type:'client',clientId:'duplicate',contextId:'a'.repeat(64),contextLabel:'Conversation A'})
  await f.settle();f.command('duplicate-effect',{action:'press',tabId:1,key:'Enter'});await f.settle()
  assert.deepEqual((await f.popup({action:'state'})).grants,[])
  assert.equal(f.calls.length,0)
  assert.equal((await f.popup({action:'grant',tabId:1,clientId:'duplicate'})).ok,false)
 }finally{await f.close()}
})
test('native loss preserves consent, automatic reconnect restores it, manual disconnect does not',async()=>{
 const f=await fixture()
 try{
  await f.popup({action:'grant',tabId:1,clientId:'client-a'})
  f.native.onDisconnect.emit();await f.settle()
  assert.equal(f.session.bindings.length,1);assert.equal(f.alarms.size,1)
  f.alarmEvent.emit({name:'xharness-native-reconnect'});await f.settle()
  f.native.onMessage.emit({type:'ready',version:1});f.native.onMessage.emit({type:'client',clientId:'replacement',contextId:'a'.repeat(64),contextLabel:'Conversation A'});await f.settle()
  assert.equal((await f.popup({action:'state'})).grants[0].clientId,'replacement')
  await f.popup({action:'disconnect'});await f.settle()
  assert.deepEqual(f.session.bindings,[]);assert.equal(f.local.autoConnect,false);assert.equal(f.alarms.size,0)
 }finally{await f.close()}
})
test('service worker activation restores exact same-origin consent, not foreign clients',async()=>{
 const f=await fixture({saved:[{tabId:1,contextId:'a'.repeat(64),origin:'https://example.test'}],enabled:true})
 try{await f.settle();assert.equal((await f.popup({action:'state'})).grants[0].clientId,'client-a');assert.equal(f.native.messages.filter(m=>m.type==='hello').length,1)}finally{await f.close()}
})

test('origin change while restoring a saved grant cancels the pending attach',async()=>{
 const f=await fixture();let release
 try{
  await f.popup({action:'grant',tabId:1,clientId:'client-a'})
  f.native.onMessage.emit({type:'clientGone',clientId:'client-a'});await f.settle()
  f.setAttach(()=>new Promise(resolve=>release=resolve))
  f.native.onMessage.emit({type:'client',clientId:'replacement',contextId:'a'.repeat(64),contextLabel:'Conversation A'});await f.settle()
  assert.equal(typeof release,'function')
  f.updated.emit(1,{url:'https://foreign.test/'})
  f.updated.emit(1,{url:'https://example.test/'})
  release();await f.settle()
  assert.deepEqual((await f.popup({action:'state'})).grants,[]);assert.deepEqual(f.session.bindings,[])
 }finally{await f.close()}
})
