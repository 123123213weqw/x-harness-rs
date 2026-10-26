import assert from 'node:assert/strict'
import { runtimeTestApi } from './runtime-source-test-harness.mjs'
import { compile, harness } from './conversation-test-harness.mjs'

const runtime = runtimeTestApi()
const api = harness(compile().test, { runtime }).plugin
const definitions = [], views = []; let fallback
api.registerConversationNodes({conversationEvents:{register:d=>definitions.push(d),registerFallback:d=>fallback=d},conversationViews:{register:d=>views.push(d)}})
const registry = (rows=definitions) => ({events:{entries:()=>rows,fallbackEntry:()=>fallback},views:{entries:()=>views}})
const assembler = (rows=definitions) => new runtime.ConversationNodeAssembler(registry(rows).events,registry(rows).views)
const trace = a => {
  a.flush(); const s=a.snapshot('chat')
  return JSON.stringify({order:s.order,nodes:s.nodes.values(),legacy:{...s.legacy,turnTimings:[...s.legacy.turnTimings??[]],turnEnds:[...s.legacy.turnEnds]},timeline:[...s.timeline.turns]})
}
const journal=[]; let seq=0
const emit=(type,data,view)=>{const row={event:{seq:seq++,time:1000+seq,type,data,...['tool/result','assistant/message','user/message'].includes(type)?{surfaceOp:'append'}:{}},view};journal.push(row);return row}
const start=turn=>emit('turn/start',{turn})
const end=turn=>emit('turn/end',{turn,reason:{kind:'completed'}})
const step=(turn,step)=>[
 emit('step/start',{turn,step}),
 emit('tool/call',{turn,step,callId:`c${turn}-${step}`,name:'bash',arguments:'{"command":"echo synthetic"}'}),
 emit('tool/result',{turn,step,message:{role:'tool',source:{kind:'tool',callId:`c${turn}-${step}`},content:[{type:'tool-result',content:[{type:'text',text:'x'.repeat(2048)}],isError:false}]}}),
 emit('assistant/message',{turn,step,message:{id:`a${turn}-${step}`,role:'assistant',content:[{type:'text',text:'answer'}]}}),
 emit('step/end',{turn,step}),
]
// Differential: the same real Definitions with opt-ins removed remain a full
// reducer-replay oracle. Check live intermediate states, not only the final turn.
const fast=assembler(), oracle=assembler(definitions.map(d=>({...d,locationReuse:undefined})))
let replayCount=0; const original=fast.replayContext
fast.replayContext=function(...args){replayCount++;return original.apply(this,args)}
const append=row=>{fast.append(row);oracle.append(row)}
append(start(0))
for(let s=0;s<160;s++){
 for(const row of step(0,s)){append(row);if(s%31===0)assert.equal(trace(fast),trace(oracle),`live boundary differential at ${s}/${row.event.type}`)}
}
append(end(0));assert.equal(trace(fast),trace(oracle),'terminal replay equality')
assert.ok(replayCount<1000,`boundary reducers must not replay old event evidence: ${replayCount}`)
// Default plugins may read changing parent membership and MUST keep replaying.
const membership={kind:'members',match:e=>e.type==='step/start'?{id:'one',role:e.data.step===0?'start':'update'}:null,start:(_c,m)=>({count:m.location.turn.steps.length}),update:(c,m)=>({count:m.location.turn.steps.length})}
const generic=assembler([membership]);generic.replaceWindow(journal.slice(0,2),false);generic.flush()
for(const row of journal.slice(2))generic.append(row)
assert.equal([...generic.contexts.values()].find(c=>c.kind==='members').state.count,160,'foreign default boundary semantics')

// Completed prefixes plateau, while a giant current turn is intentionally
// pinned. These are UI windows only: the fake Host below keeps every raw row.
const session=new runtime.Session('long-loop',{sessions:{history:async({beforeSeq=Infinity})=>{
 const eligible=journal.filter(row=>row.event.seq<beforeSeq),events=eligible.slice(-600)
 return {result:{ok:true,value:{events,hasMore:eligible.length>events.length}}}
}}},{},{conversation:registry()})
session.installWindow([],false);session.openState='open';session.handleRunning(true)
let peak=0
for(const row of journal){session.acceptLiveEvent(row.event,row.view);session.getSnapshot()}
for(let turn=1;turn<=32;turn++){
 const rows=[emit('user/message',{id:'u'+turn,source:{kind:'user'},content:[{type:'text',text:'Preserve the pre-turn prompt'}]}),start(turn)];for(let s=0;s<64;s++)rows.push(...step(turn,s));rows.push(end(turn))
 for(const row of rows){session.acceptLiveEvent(row.event,row.view);session.getSnapshot();peak=Math.max(peak,session.events.length)}
}
assert.ok(peak<=4100,`event high water: ${peak}`)
assert.ok(session.baseSeq>0&&session.hasMore,'older history remains available')
assert.equal(session.events.at(-1),journal.at(-1).event,'live tail preserved')
assert.equal(session.events[0].type,'user/message','the pre-turn user prompt must not be evicted with the preceding turn')
const retained=session.events.length
await session.loadOlder();assert.ok(session.events.length>retained,'explicit older page stays pinned')
while(session.hasMore)await session.loadOlder()
assert.equal(JSON.stringify(session.events),JSON.stringify(journal.map(row=>row.event)),'every original durable event reloads exactly')
const all=session.events.length;session.getSnapshot();assert.equal(session.events.length,all,'reader pin is not silently evicted')
session.setHistoryOpenTarget({kind:'latest'});session.notifier.markDirty();session.getSnapshot()
assert.ok(session.events.length<all,'returning to latest releases old reader pages')
// No hidden truncation inside an unfinished turn; earlier file/tool evidence stays.
const big=new runtime.Session('pinned',{}, {},{conversation:registry()});big.installWindow([],false);big.openState='open'
const first=start(99);big.acceptLiveEvent(first.event)
for(let n=0;n<900;n++)for(const row of step(99,n))big.acceptLiveEvent(row.event,row.view)
big.getSnapshot();assert.equal(big.events[0],first.event,'unfinished turn remains intact beyond high water')
// Payload pressure must trim even with far fewer than 4,096 events.
const byteWindow=new runtime.Session('payload-budget',{}, {},{conversation:registry()});byteWindow.installWindow([],false);byteWindow.openState='open'
let byteSeq=0
const byteEvent=(type,data)=>{byteWindow.acceptLiveEvent({seq:byteSeq++,time:byteSeq,type,data,surfaceOp:'append'});byteWindow.getSnapshot()}
for(let turn=0;turn<50;turn++){
 byteEvent('turn/start',{turn});byteEvent('step/start',{turn,step:0})
 byteEvent('tool/call',{turn,step:0,callId:'large'+turn,name:'bash',arguments:'{}'})
 byteEvent('tool/result',{turn,step:0,message:{role:'tool',source:{kind:'tool',callId:'large'+turn},content:[{type:'tool-result',content:[{type:'text',text:'x'.repeat(100000)}],isError:false}]}})
 byteEvent('step/end',{turn,step:0});byteEvent('turn/end',{turn,reason:{kind:'completed'}})
}
assert.ok(byteWindow.events.length<byteSeq&&byteWindow.hasMore,'byte budget is independent of event count')
assert.ok(byteWindow.eventBytes<=8*1024*1024,'eligible byte-heavy turns remain under high water')

// Reader anchor, queue/pending interaction objects and scope are independent.
session.setHistoryOpenTarget({kind:'anchor',seq:0});session.pending.set('sentinel',{kind:'question'});session.actx={draft:'do not touch'}
assert.equal(session.actx.draft,'do not touch');assert.equal(session.pending.size,1)

// A state-only plugin predecessor or cross-window tool Context must pin the
// prefix instead of silently rebuilding from incomplete business evidence.
const chain={kind:'chain',match:e=>e.type==='probe'?{id:String(e.seq),role:'start'}:null,start:(_c,m,r)=>({n:(r.previous('chain')?.state.n??0)+1}),update:c=>c.state}
const dependent=assembler([chain]);dependent.replaceWindow([{event:{seq:1,type:'probe',data:{},time:1}},{event:{seq:2,type:'probe',data:{},time:2}}],false);dependent.flush()
assert.equal(dependent.canTrimBefore(2),false,'cross-window predecessor state is pinned')
assert.equal(dependent.canTrimBefore(1),true)
const overlap=assembler([{...chain,match:e=>e.type==='probe'?{id:'same',role:e.seq===1?'start':'update'}:null}]);overlap.replaceWindow([{event:{seq:1,type:'probe',data:{},time:1}},{event:{seq:2,type:'probe',data:{},time:2}}],false);overlap.flush()
assert.equal(overlap.canTrimBefore(2),false,'a spanning Context retains its start evidence')

// Stop is admitted synchronously, single-flight, and ACK does not fake an end.
let complete, count=0
const control=new runtime.Session('control',{sessions:{cancel:()=>{count++;return new Promise(r=>complete=r)}}},{})
control.handleRunning(true);const p=control.cancel();assert.equal(count,1);assert.equal(control.cancel(),p)
assert.equal(control.getSnapshot().stopRequested,true);assert.equal(control.getSnapshot().running,true)
complete({result:{ok:true,value:{accepted:true}}});await p;await control.cancel();assert.equal(count,1)
assert.equal(control.getSnapshot().stopRequested,true,'ACK is not turn completion')
control.handleRunning(false);assert.equal(control.getSnapshot().stopRequested,false)
control.handleRunning(true);const failed=control.cancel();complete({result:{ok:false,error:{code:'offline',message:'retry'}}});await failed
assert.equal(control.getSnapshot().stopRequested,false);assert.equal(control.getSnapshot().promptError.op,'stop')
const stale=control.cancel();control.handleRunning(false);control.handleRunning(true);complete({result:{ok:false,error:{code:'old',message:'old'}}});await stale
assert.notEqual(control.getSnapshot().promptError.error.code,'old','stale failure cannot poison the next turn')

// Actual production manager enables cooperative delivery; direct test Sessions
// stay synchronous for old consumers. Control frames bypass queued reductions.
const manager=new runtime.SessionManager({}, {},undefined,undefined,registry()),cooperative=manager.get('cooperative')
assert.ok(cooperative.delivery,'production queue is wired')
cooperative.installWindow([],false);cooperative.openState='open'
let clock=0, delivered=[];cooperative.delivery.now=()=>clock
cooperative.acceptLiveEvent=(event)=>{delivered.push(event.seq);clock+=5}
for(let n=0;n<30;n++)cooperative.handleMuxEnvelope('id',{type:'session/event',event:{seq:n,type:'noop',data:{},time:n}})
assert.ok(delivered.length<30,'burst yields to the event loop')
cooperative.handleRunning(true);assert.equal(cooperative.getSnapshot().running,true,'control status bypasses backlog')
await new Promise(r=>setTimeout(r,100));assert.deepEqual(delivered,Array.from({length:30},(_,i)=>i),'FIFO order exact')
for(let n=30;n<45;n++)cooperative.handleMuxEnvelope('id',{type:'session/event',event:{seq:n,type:'noop',data:{},time:n}})
cooperative.invalidateConnectionGeneration();const atDeath=delivered.length
await new Promise(r=>setTimeout(r,20));assert.equal(delivered.length,atDeath,'dead generation has no scheduled deliveries')
// Wall time spent in microtask snapshot flushes is not an idle interval.
// A producer that never yields a task must still give input a scheduling turn.
const micro=manager.get('microtasks');micro.installWindow([],false);micro.openState='open'
let virtual=0;const microDelivered=[];micro.delivery.now=()=>virtual
micro.acceptLiveEvent=event=>microDelivered.push(event.seq)
for(let n=0;n<20;n++){
 micro.handleMuxEnvelope('id',{type:'session/event',event:{seq:n,type:'noop',data:{},time:n}})
 virtual+=5;await Promise.resolve()
}
assert.ok(microDelivered.length<=1,'microtask storms cannot continuously reset the input budget')
await new Promise(r=>setTimeout(r,30));assert.deepEqual(microDelivered,Array.from({length:20},(_,i)=>i))
micro.delivery.clear()

const broken=manager.get('broken-delivery');broken.installWindow([],false);broken.openState='open'
broken.delivery.deliver=()=>{throw Error('controlled reducer failure')}
broken.delivery.reset=setTimeout(()=>{},1000);broken.delivery.spent=5
broken.delivery.push({event:{seq:0,type:'noop',data:{},time:0}},1)
await new Promise(r=>setTimeout(r,20))
assert.equal(broken.delivery.timer,undefined,'throwing deferred delivery cannot strand a FIFO')
assert.equal(broken.delivery.reset,undefined)
assert.match(broken.openError.message,/controlled reducer failure/)

// Overflow preserves the committed view and requires history-only recovery.
const flooded=manager.get('flooded');flooded.installWindow([],false);flooded.openState='open';flooded.delivery.reset=setTimeout(()=>{},1000);flooded.delivery.spent=10;flooded.delivery.epoch=Date.now();flooded.delivery.now=()=>Date.now()
for(let n=0;n<520;n++)flooded.handleMuxEnvelope('id',{type:'session/event',event:{seq:n,type:'noop',data:{},time:n}})
assert.equal(flooded.openState,'error');assert.match(flooded.openError.message,/backlog/);assert.ok(flooded.liveBuffer.length<4096)
flooded.delivery.clear()
await new Promise(r=>setTimeout(r,10))
const durable=Array.from({length:520},(_,seq)=>({event:{seq,type:'noop',data:{},time:seq}}))
flooded.history=async()=>({result:{ok:true,value:{events:durable,hasMore:false}}})
await flooded.retryHistory()
assert.equal(flooded.openState,'open','bounded overload recovers using history only')
assert.equal(JSON.stringify(flooded.events),JSON.stringify(durable.map(row=>row.event)))
assert.equal(flooded.delivery.timer,undefined,'no orphaned backlog timer')
console.log(JSON.stringify({test:'active-session-working-set',journal:journal.length,peakEvents:peak,retainedEvents:session.events.length,reducerReplays:replayCount,passed:true}))
