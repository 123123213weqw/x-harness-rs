import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
const id='shell-navigation-test'
const bytes=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id,source:'src/modules/layout/shell-navigation.ts'}]).get(id).bytes.toString()
let registration
vm.runInNewContext(bytes,{window:{__ModuleLoader__:{load:r=>registration=r}},Event,CustomEvent,queueMicrotask})
const {ShellNavigation,SHELL_HISTORY_LIMIT}=registration.factory()
const tick=()=>new Promise(resolve=>queueMicrotask(resolve))
const json=value=>JSON.parse(JSON.stringify(value))
function fixture({current='a',pending=false}={}){
 let state={current:current??undefined,ids:['a','b','c'],byId:{a:{},b:{},c:{}},phase:pending?'pending':'ready',subagentsByParent:{}}
 const listeners=new Set(),writes=[],target=new EventTarget(),addresses=new Map()
 const list={getSnapshot:()=>state,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}}
 const set=next=>{state=next;for(const f of [...listeners])f()}
 const sessions={list,open:id=>{assert.ok(state.ids.includes(id)||addresses.has(id));writes.push({open:id});set({...state,current:id})},clear:()=>{writes.push({clear:true});set({...state,current:undefined})},subagentAddress:id=>addresses.get(id)}
 const nav=new ShellNavigation(sessions),dispose=nav.mount(target)
 const page=async page=>{target.dispatchEvent(new Event(`xharness:${page}:open`));await tick()}
 const select=async id=>{sessions.open(id);await tick()}
 return {nav,list,set,sessions,writes,target,addresses,page,select,dispose,listeners}
}
test('initial/restored selection is one visit; unchanged metadata creates no history',async()=>{
 const f=fixture();assert.deepEqual(json(f.nav.getSnapshot()),{route:{page:'chat',sessionId:'a'},canBack:false,canForward:false})
 f.set({...f.list.getSnapshot(),byId:{a:{title:'renamed'},b:{},c:{}}});await tick();assert.equal(f.nav.getSnapshot().canBack,false)
 f.dispose();assert.equal(f.listeners.size,0)
})
test('session back/forward, duplicates and a new visit prune only the forward branch',async()=>{
 const f=fixture();await f.select('b');await f.select('b');f.nav.back();assert.equal(f.nav.getSnapshot().route.sessionId,'a');assert.equal(f.nav.getSnapshot().canBack,false)
 f.nav.forward();assert.equal(f.nav.getSnapshot().route.sessionId,'b');f.nav.back();await f.select('c');assert.equal(f.nav.getSnapshot().canForward,false)
 f.nav.back();assert.equal(f.nav.getSnapshot().route.sessionId,'a');assert.equal(f.nav.getSnapshot().canBack,false);f.dispose()
})
test('all center pages use one route stream; replay is presentation, never open-intent',async()=>{
 const f=fixture(),intents=[],projections=[]
 for(const page of ['plugins','work','review','assistant'])f.target.addEventListener(`xharness:${page}:open`,()=>intents.push(page))
 f.target.addEventListener('xharness:shell-route-changed',event=>projections.push(event.detail.page))
 for(const page of ['plugins','work','review','assistant'])await f.page(page)
 f.nav.back();assert.equal(f.nav.getSnapshot().route.page,'review');f.nav.back();assert.equal(f.nav.getSnapshot().route.page,'work');f.nav.forward();assert.equal(f.nav.getSnapshot().route.page,'review')
 assert.deepEqual(intents,['plugins','work','review','assistant']);assert.deepEqual(projections.slice(-3),['review','work','review']);assert.equal(f.writes.length,0);f.dispose()
})
test('same gesture page+session selection records one route regardless of listener order',async()=>{
 for(const before of [true,false]){
  const f=fixture();const choose=()=>f.sessions.open('b')
  if(before){f.dispose();f.target.addEventListener('xharness:assistant:open',choose);f.dispose=f.nav.mount(f.target)}
  else f.target.addEventListener('xharness:assistant:open',choose)
  await f.page('assistant');assert.deepEqual(json(f.nav.getSnapshot().route),{page:'assistant',sessionId:'b'})
  f.nav.back();assert.deepEqual(json(f.nav.getSnapshot().route),{page:'chat',sessionId:'a'});assert.equal(f.nav.getSnapshot().canBack,false)
  f.nav.forward();assert.deepEqual(json(f.nav.getSnapshot().route),{page:'assistant',sessionId:'b'});assert.equal(f.writes.filter(x=>x.open==='b').length,2,'exactly original selection + explicit forward, not another feature request');f.dispose()
 }
})
test('catalog-addressed child returns to parent and can go forward after leaving byId',async()=>{
 const f=fixture();f.addresses.set('child',{parentSessionId:'a',childSessionId:'child',mode:'read-write'});f.set({...f.list.getSnapshot(),subagentsByParent:{a:{entries:[{id:'child',kind:'child'}]}}});await f.select('child')
 f.nav.back();assert.equal(f.list.getSnapshot().current,'a');assert.equal(f.nav.getSnapshot().canForward,true);f.nav.forward();assert.equal(f.list.getSnapshot().current,'child');f.nav.back()
 f.set({...f.list.getSnapshot(),subagentsByParent:{a:{entries:[{id:'child',kind:'removed'}]}}});await tick();assert.equal(f.nav.getSnapshot().canForward,false);f.nav.forward();assert.equal(f.list.getSnapshot().current,'a');f.dispose()
})
test('deleted sessions are skipped, without opening or recreating them',async()=>{
 const f=fixture();await f.select('b');await f.select('c');f.set({...f.list.getSnapshot(),ids:['a','c'],byId:{a:{},c:{}}});await tick();f.writes.length=0
 f.nav.back();assert.equal(f.nav.getSnapshot().route.sessionId,'a');f.nav.forward();assert.equal(f.nav.getSnapshot().route.sessionId,'c');assert.deepEqual(f.writes,[{open:'a'},{open:'c'}]);f.dispose()
})
test('transient pending/masked reconnect is not a new empty visit',async()=>{
 const f=fixture();await f.select('b');f.nav.back();const old=f.list.getSnapshot()
 f.set({...old,phase:'pending',ids:[],byId:{},current:undefined});await tick();assert.equal(f.nav.getSnapshot().canForward,false);f.nav.forward();assert.equal(f.nav.getSnapshot().route.sessionId,'a')
 f.set({...old,byId:{},ids:[],current:undefined});await tick();assert.equal(f.nav.getSnapshot().route.sessionId,'a')
 f.set(old);await tick();assert.equal(f.nav.getSnapshot().canForward,true);f.nav.forward();assert.equal(f.nav.getSnapshot().route.sessionId,'b');f.dispose()
})
test('intentional empty view is navigable; never creates a session or starts/stops Agents',async()=>{
 const f=fixture();f.sessions.clear();await tick();assert.equal(f.nav.getSnapshot().route.sessionId,undefined);f.nav.back();assert.equal(f.list.getSnapshot().current,'a');f.nav.forward();assert.equal(f.list.getSnapshot().current,undefined);assert.deepEqual(f.writes,[{clear:true},{open:'a'},{clear:true}]);f.dispose()
})
test('rapid back/forward commits synchronously and does not self-record',async()=>{
 const f=fixture();await f.select('b');await f.select('c');f.nav.back();f.nav.back();f.nav.back();assert.equal(f.list.getSnapshot().current,'a');f.nav.forward();f.nav.forward();await tick();assert.equal(f.list.getSnapshot().current,'c');assert.equal(f.nav.getSnapshot().canForward,false);f.dispose()
})
test('unaccepted selection does not advance history; errors do not leave replay locked',async()=>{
 const f=fixture();await f.select('b');const open=f.sessions.open;f.sessions.open=()=>{throw Error('port rejected')};assert.throws(()=>f.nav.back(),/port rejected/);assert.equal(f.nav.getSnapshot().route.sessionId,'b');f.sessions.open=()=>{};f.nav.back();assert.equal(f.nav.getSnapshot().route.sessionId,'b');f.sessions.open=open;f.nav.back();assert.equal(f.nav.getSnapshot().route.sessionId,'a');f.dispose()
})
test('bounded history stores only route ids, with no transcript retention',async()=>{
 const f=fixture();for(let i=0;i<SHELL_HISTORY_LIMIT+20;i++)await f.select(i%2?'a':'b')
 let count=0;while(f.nav.getSnapshot().canBack){f.nav.back();assert.ok(++count<=SHELL_HISTORY_LIMIT)}assert.equal(count,SHELL_HISTORY_LIMIT-1);f.dispose()
})
test('cleanup cancels queued visits; remount observes current state with one subscription',async()=>{
 const f=fixture();f.target.dispatchEvent(new Event('xharness:work:open'));f.dispose();f.nav.back();f.nav.forward();f.nav.close();await tick();assert.equal(f.nav.getSnapshot().route.page,'chat');assert.equal(f.listeners.size,0);assert.equal(f.writes.length,0)
 const off=f.nav.mount(f.target);assert.equal(f.listeners.size,1);await f.page('work');assert.equal(f.nav.getSnapshot().route.page,'work');off();assert.equal(f.listeners.size,0)
})

test('initial offline Host never gates local pages or back/forward and binding retains history',async()=>{
 const f=fixture({pending:true,current:null});f.set({...f.list.getSnapshot(),current:undefined,ids:[],byId:{}});await tick()
 for(const page of ['plugins','work','review','assistant']){await f.page(page);assert.equal(f.nav.getSnapshot().route.page,page)}
 f.nav.back();assert.equal(f.nav.getSnapshot().route.page,'review');f.nav.back();assert.equal(f.nav.getSnapshot().route.page,'work');f.nav.forward();assert.equal(f.nav.getSnapshot().route.page,'review');assert.deepEqual(f.writes,[])
 f.set({...f.list.getSnapshot(),phase:'ready',current:'a',ids:['a','b'],byId:{a:{},b:{}}});await tick()
 assert.deepEqual(json(f.nav.getSnapshot().route),{page:'review',sessionId:'a'});assert.equal(f.nav.getSnapshot().canForward,true)
 f.nav.forward();assert.equal(f.nav.getSnapshot().route.page,'assistant');assert.deepEqual(f.writes,[])
 f.nav.back();f.nav.back();f.nav.back();f.nav.back();assert.deepEqual(json(f.nav.getSnapshot().route),{page:'chat',sessionId:'a'});assert.equal(f.nav.getSnapshot().canBack,false);assert.deepEqual(f.writes,[]);f.dispose()
})
test('first loaded empty selection is intentional and retained across session visits',async()=>{
 const f=fixture({pending:true,current:null});f.set({...f.list.getSnapshot(),current:undefined,ids:[],byId:{}});await tick();await f.page('plugins')
 f.set({...f.list.getSnapshot(),phase:'ready',current:undefined,ids:['a'],byId:{a:{}}});await tick();await f.select('a')
 f.nav.back();assert.deepEqual(json(f.nav.getSnapshot().route),{page:'plugins'});assert.equal(f.list.getSnapshot().current,undefined);f.dispose()
})
test('pending reconnect permits same-session page navigation without selection writes',async()=>{
 const f=fixture();await f.page('plugins');await f.select('b');f.nav.back();const old=f.list.getSnapshot();f.writes.length=0
 f.set({...old,phase:'pending',current:undefined,ids:[],byId:{}});await tick();f.nav.back();assert.equal(f.nav.getSnapshot().route.page,'chat');assert.equal(f.nav.getSnapshot().route.sessionId,'a');f.nav.forward();assert.equal(f.nav.getSnapshot().route.page,'plugins');assert.equal(f.nav.getSnapshot().canForward,false);assert.deepEqual(f.writes,[])
 f.set(old);await tick();assert.equal(f.nav.getSnapshot().canForward,true);f.nav.forward();assert.equal(f.nav.getSnapshot().route.sessionId,'b');f.dispose()
})

test('remounted navigation markers request a projection, not another feature open',async()=>{
 const f=fixture(),projections=[],intents=[];f.target.addEventListener('xharness:shell-route-changed',e=>projections.push(e.detail.page));f.target.addEventListener('xharness:review:open',()=>intents.push('review'))
 await f.page('review');const before=json(f.nav.getSnapshot());f.target.dispatchEvent(new Event('xharness:shell-route-requested'));assert.deepEqual(projections,['review','review']);assert.deepEqual(intents,['review']);assert.deepEqual(f.writes,[]);assert.deepEqual(json(f.nav.getSnapshot()),before);f.dispose();f.target.dispatchEvent(new Event('xharness:shell-route-requested'));assert.equal(projections.length,2)
})
