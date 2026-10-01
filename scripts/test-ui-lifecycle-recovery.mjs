// Execute shipped code: fixtures replace only transport and view registrations.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {patchConversationLifecycle} from './patch-conversation-lifecycle.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const source=read('../ui/dist/plugins/@xharness/dsh-client-runtime/client.js');
const ui=read('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js');
assert.equal(patchConversationLifecycle(Buffer.from(ui)).toString(),ui);
assert.throws(()=>patchConversationLifecycle(Buffer.from('changed upstream')),/anchor changed/);
let reg;
vm.runInNewContext(source.replace('exports.apply = apply;','exports.Session = Session; exports.SessionManager = SessionManager; exports.apply = apply;'),{
 window:{__ModuleLoader__:{load:x=>reg=x}},console,URL,AbortController,setTimeout,clearTimeout,queueMicrotask,
 requestAnimationFrame:f=>setTimeout(f,0),cancelAnimationFrame:clearTimeout,
});
const runtime=reg.factory(id=>id==='@xharness/cordis'?{Service:class{}}:{});
const plain=x=>JSON.parse(JSON.stringify(x));
const empty={events:{entries:()=>[],fallbackEntry:()=>undefined},views:{entries:()=>[]}};
const ok=events=>({result:{ok:true,value:{events,hasMore:false}}});
const requested=kind=>({type:kind+'/requested',sessionId:'audit',...(kind==='approval'?{approvalId:'a1',toolName:'bash',callId:'t1'}:{questions:[{id:'q1',question:'Choose?',options:[]}],deferred:false})});
for(const kind of ['approval','question']) for(const early of [true,false]) {
 const api={sessions:{history:async()=>ok([])},respond:async()=>({ok:true})};
 const manager=new runtime.SessionManager(api,{},undefined,undefined,empty);
 manager.refreshList=async()=>{};manager.refreshSubagents=async()=>{};
 const session=manager.get('audit');session.openState='open';
 manager.handleMuxEnvelope({rpcId:'old',payload:requested(kind)});
 const old=[...session.pending.values()][0];
 manager.handleDisconnected();
 assert.equal(session.pending.size,0);
 assert.throws(()=>old.respond({ok:true,value:{}}),/already settled/);
 assert.equal(manager.pendingInteractions.size,0);
 const frame={rpcId:'new',payload:requested(kind)};
 if(early)manager.handleMuxEnvelope(frame);
 manager.handleConnected();await session.openPromise;
 if(!early)manager.handleMuxEnvelope(frame);
 assert.equal(session.pending.size,1,kind+' survives readiness in either order');
 assert.equal(manager.pendingInteractions.size,1);
 const wait=[...session.pending.values()][0];
 await session.resync();assert.equal([...session.pending.values()][0],wait,'history-only resync preserves baseline');
 if(kind==='question') {
  manager.handleMuxEnvelope({rpcId:'new',payload:{...requested(kind),deferred:true}});
  assert.equal(session.pending.size,1);assert.equal([...session.pending.values()][0].payload.deferred,true);
 }
 manager.handleMuxEnvelope({rpcId:'resolved',payload:{type:kind+'/resolved',sessionId:'audit',...(kind==='approval'?{approvalId:'a1'}:{questionRpcId:'new'})}});
 assert.equal(session.pending.size,0);assert.equal(manager.pendingInteractions.size,0);
 // Closed while disconnected: no replay means no phantom prompt on reconnect.
 manager.handleDisconnected();manager.handleConnected();await session.openPromise;
 assert.equal(session.pending.size,0);
}
// A dead generation's in-flight history result cannot publish after disconnect.
let release;
const manager=new runtime.SessionManager({sessions:{history:()=>new Promise(r=>release=r)}},{},undefined,undefined,empty);
const loading=manager.get('audit');const oldOpen=loading.open();await Promise.resolve();
manager.handleDisconnected();release(ok([]));await oldOpen;assert.notEqual(loading.openState,'open');
// Actual stream controller: baseline arrives while host.describe is pending.
const fresh=patchConversationLifecycle(Buffer.from(read('../tests/fixtures/retry-definition-legacy.js'))).toString();
assert.equal(patchConversationLifecycle(Buffer.from(fresh)).toString(),fresh,'fresh patch is idempotent');
assert.ok(fresh.includes('fallbackRetryState(context)'));
const connection=read('../ui/dist/plugins/@xharness/dsh-client-connection/client.js');
const cStart=connection.indexOf('const CONNECTION_DEFAULTS ='),cEnd=connection.indexOf('//#endregion',cStart);
const conn=vm.createContext({console,AbortController,setTimeout,clearTimeout});
vm.runInContext(connection.slice(cStart,cEnd)+'\nglobalThis.Controller=ConnectionController;',conn);
let resolveDescribe,connectedResolve;
const description=new Promise(r=>resolveDescribe=r),completed=new Promise(r=>connectedResolve=r);
const connectedManager=new runtime.SessionManager({sessions:{history:async()=>ok([])}},{},undefined,undefined,empty);
connectedManager.refreshList=async()=>{};connectedManager.refreshSubagents=async()=>{};
const connectedSession=connectedManager.get('audit');connectedSession.openState='open';connectedManager.handleDisconnected();
async function* stream(signal,onOpen,mux){onOpen();if(mux)yield {rpcId:'fresh',payload:requested('question')};await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener('abort',r,{once:true})});}
const controller=new conn.Controller({events:{mux:(_,s,o)=>stream(s,o,true),host:(_,s,o)=>stream(s,o,false)},host:{describe:()=>description}},{
 onMuxEnvelope:e=>{connectedManager.handleMuxEnvelope(e);setTimeout(()=>resolveDescribe({result:{ok:true,value:{}}}),0)},
 onConnected:()=>{connectedManager.handleConnected();connectedSession.openPromise.then(()=>{assert.equal(connectedSession.pending.size,1);controller.stop();connectedResolve()})},
});
controller.start();await completed;

// Retry restoration: all suffixes, reconnects, prepend splits and duplicates.
const ctx=vm.createContext({_xharness_dsh_client_runtime_client:runtime});
for(const name of ['contextLocation','chatNode']){const s=ui.indexOf(`function ${name}(`),e=ui.indexOf('\n\t\t}',s);vm.runInContext(ui.slice(s,e+4),ctx);}
const rStart=ui.indexOf('function scheduledNode('),rEnd=ui.indexOf('//#endregion',rStart);
vm.runInContext(ui.slice(rStart,rEnd)+'\nglobalThis.definition=retryDefinition;',ctx);
function assembler(def,build=()=>{let nodes=new Map();return{empty:[],replace:x=>{nodes=new Map(x.nodes.map(n=>[n.key,n]));return [...nodes.values()]},apply:x=>{for(const n of x.upserts)nodes.set(n.key,n);return [...nodes.values()]}}}) {
 return new runtime.ConversationNodeAssembler({entries:()=>[def],fallbackEntry:()=>undefined},{entries:()=>[{target:def.target,create:build}]});
}
const rows=['turn/start','step/start','llm/retry','llm/retry-started','llm/retry','llm/retry-started','step/end','turn/end'].map((type,seq)=>({event:{seq,time:seq+1,type,data:{turn:0,step:1,...(type.startsWith('llm/')?{retryId:'chain',retry:seq<4?1:2,...(type==='llm/retry'?{delayMs:500,mode:'normal',maxRetries:2,failure:{message:'network'}}:{})}:{})}}}));
const full=assembler(ctx.definition);full.replaceWindow(rows,false);full.flush();
const expected=plain(full.snapshot('chat'));
for(let split=0;split<=rows.length;split++) {
 const paged=assembler(ctx.definition);paged.replaceWindow(rows.slice(split),split>0);paged.flush();
 if(split<=5)assert.equal(paged.snapshot('chat').length,1,'available retry evidence renders');
 paged.prepend(rows.slice(0,split),false);paged.flush();assert.deepEqual(plain(paged.snapshot('chat')),expected);
 paged.prepend(rows.slice(0,split),false);paged.flush();assert.deepEqual(plain(paged.snapshot('chat')),expected);
 const resumed=assembler(ctx.definition);resumed.replaceWindow(rows.slice(0,split),false);resumed.flush();
 for(const row of rows.slice(split)){resumed.append(row);resumed.flush();resumed.append(row);resumed.flush()}
 assert.deepEqual(plain(resumed.snapshot('chat')),expected);
}
const startedOnly=assembler(ctx.definition);startedOnly.replaceWindow([rows[5]],true);startedOnly.flush();
const partial=startedOnly.snapshot('chat')[0].data.current;assert.equal(partial.partial,true);assert.equal(partial.retryState,'started');assert.equal(partial.failure,undefined);assert.equal(partial.delayMs,undefined);
const scheduled=assembler(ctx.definition);scheduled.replaceWindow([rows[4],rows[6],rows[7]],true);scheduled.flush();assert.equal(scheduled.snapshot('chat')[0].data.current.retryState,'cancelled');

// Selective immutable reuse, with isolated view builders and transactional rollback.
let builds=0,reduces=0,failBuild=false,failReduce=false;
const def={kind:'cost',historyReuse:'local',target:'probe',match:e=>({id:String(e.data.id??e.seq),role:e.data.role??'start'}),start:()=>{reduces++;return{}},update:c=>{reduces++;if(failReduce)throw Error('reducer');return c.state},buildViewNode:c=>{builds++;return{key:c.key,target:'probe',seq:c.startSeq}}};
const create=()=>({empty:[],replace:x=>{if(failBuild)throw Error('builder');return x.nodes},apply:x=>x.upserts});
const entry=seq=>({event:{seq,time:seq,type:'audit',data:{}}});
for(const n of [100,1000,10000]) {
 const a=assembler(def,create);const existing=Array.from({length:n},(_,i)=>entry(i+50));a.replaceWindow(existing,true);a.flush();
 const oldData=[...a.contexts.values()].at(-1).state;
 builds=0;reduces=0;const older=Array.from({length:50},(_,i)=>entry(i));a.prepend(older,false);a.flush();
 assert.equal(builds,50);assert.equal(reduces,50);assert.equal([...a.contexts.values()].find(c=>c.startSeq===n+49).state,oldData);
 const rebuilt=assembler(def,create);rebuilt.replaceWindow([...older,...existing],false);rebuilt.flush();assert.deepEqual(plain(a.snapshot('probe')),plain(rebuilt.snapshot('probe')));
 console.log(`history reuse: ${n} existing + 50 older -> 50 reducers / 50 node builds`);
}
const a=assembler(def,create);a.replaceWindow([entry(10)],true);a.flush();const committed=a.inputs,snapshot=a.snapshot('probe');
failBuild=true;assert.throws(()=>a.prepend([entry(5)],true),/builder/);failBuild=false;assert.equal(a.inputs,committed);assert.equal(a.snapshot('probe'),snapshot);
failReduce=true;assert.throws(()=>a.prepend([entry(1),{event:{seq:2,time:2,type:'audit',data:{id:1,role:'update'}}}],false),/reducer/);failReduce=false;assert.equal(a.inputs,committed);
// New evidence on an existing Context invalidates reuse; the old state survives failure.
assert.throws(()=>a.prepend([{event:{seq:5,time:5,type:'audit',data:{id:10,role:'update'}}}],false),/before its start/);assert.equal(a.inputs,committed);
// An undeclared plugin remains conservative and still runs its reducer.
const conservative=assembler({...def,historyReuse:undefined},create);conservative.replaceWindow([entry(10)],true);conservative.flush();builds=0;conservative.prepend([entry(5)],false);conservative.flush();assert.equal(builds,2);
// Changed predecessor and incomplete-history gap must invalidate dependent state.
const dependent={...def,kind:'dependent',start:(_c,m,reader)=>({previous:reader.previous('dependent')?.state,count:m.event.seq})};
const d=assembler(dependent);d.replaceWindow([entry(10)],true);d.flush();const previous=d.contexts.values().next().value.state;
d.prepend([entry(5)],false);d.flush();const now=[...d.contexts.values()].find(c=>c.startSeq===10).state;assert.notEqual(now,previous);assert.equal(now.previous.count,5);
console.log('UI lifecycle: reconnect baseline ordering, stale waits, retry suffixes, atomic selective history reuse passed');
// Audited Assistant state keeps final Match metadata. Reuse must rebind that
// Match and its mutable Location reader, rather than retaining an old timeline.
const assistantStart=ui.indexOf('function initialState(turn, step)'),assistantEnd=ui.indexOf('//#endregion',assistantStart);
vm.runInContext('const CHAT_SYNTHETIC_SEQ_OFFSETS={interruptedAssistant:-0.9};\n'+ui.slice(assistantStart,assistantEnd)+'\nglobalThis.assistant=assistantDefinition;',ctx);
function turn(turn,base){return [
 {event:{seq:base,time:base+1,type:'turn/start',data:{turn}}},
 {event:{seq:base+1,time:base+2,type:'step/start',data:{turn,step:1}}},
 {event:{seq:base+2,time:base+3,type:'assistant/message',surfaceOp:'append',data:{turn,step:1,message:{id:'a'+turn,content:[{type:'reasoning',text:'thought'},{type:'text',text:'answer'}]}}}},
 {event:{seq:base+3,time:base+4,type:'step/end',data:{turn,step:1}}},
 {event:{seq:base+4,time:base+5,type:'turn/end',data:{turn,reason:{kind:'completed'}}}},
]}
const assistant=assembler(ctx.assistant),latest=turn(1,5),older=turn(0,0);
assistant.replaceWindow(latest,true);assistant.flush();const oldContext=[...assistant.contexts.values()][0],oldMatch=oldContext.state.final;
assistant.prepend(older,false);assistant.flush();const newContext=[...assistant.contexts.values()].find(c=>c.id==='1:1');
assert.notEqual(newContext.state.final,oldMatch);assert.equal(newContext.state.final,newContext.matches.find(m=>m.event.type==='assistant/message'));
assert.notEqual(newContext.state.final.location.step.data,oldMatch.location.step.data);
const rebuiltAssistant=assembler(ctx.assistant);rebuiltAssistant.replaceWindow([...older,...latest],false);rebuiltAssistant.flush();assert.deepEqual(plain(assistant.snapshot('chat')),plain(rebuiltAssistant.snapshot('chat')));
// Evidence missing from a boundary must be reinterpreted when it is paged in.
const incomplete=assembler(ctx.assistant);incomplete.replaceWindow(latest.slice(2),true);incomplete.flush();incomplete.prepend(latest.slice(0,2),false);incomplete.flush();
const complete=assembler(ctx.assistant);complete.replaceWindow(latest,false);complete.flush();assert.deepEqual(plain(incomplete.snapshot('chat')),plain(complete.snapshot('chat')));
// Real Session.loadOlder takes the selective path, not only Assembler.prepend.
let sessionBuilds=0;
const sessionDef={...def,buildViewNode:c=>{sessionBuilds++;return{key:c.key,target:'probe',seq:c.startSeq}}};
const sessionRegistry={events:{entries:()=>[sessionDef],fallbackEntry:()=>undefined},views:{entries:()=>[{target:'probe',create}]}};
const pagedSession=new runtime.Session('audit',{sessions:{history:async()=>({result:{ok:true,value:{events:[entry(5)],hasMore:false}}})}},{},{conversation:sessionRegistry});
pagedSession.installWindow([entry(10)],true);pagedSession.openState='open';sessionBuilds=0;await pagedSession.loadOlder();assert.equal(sessionBuilds,1);assert.equal(pagedSession.openState,'open');
console.log('Assistant match rebinding, boundary invalidation and real Session pagination passed');
// Started-only metadata must be renderable, not merely accepted by the reducer.
const renderContext=vm.createContext({react:{useMemo:f=>f(),useState:f=>[f(),()=>{}],useEffect:()=>{}},react_jsx_runtime:{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},MessageItem_module_css_default:{},Date,window:{setInterval,clearInterval}});
for(const name of ['retrySeconds','ModelRetryItem']){const s=ui.indexOf(`function ${name}(`),e=ui.indexOf('\n\t\t}',s);vm.runInContext(ui.slice(s,e+4),renderContext);}
assert.doesNotThrow(()=>renderContext.ModelRetryItem({node:partial,active:false,t:(_key,args)=>args??'label'}));
console.log('Started-only retry renderer accepts missing schedule/failure metadata');

// Repeated transactions must not keep per-transaction closures or old Matches.
const repeated=assembler(ctx.assistant);repeated.replaceWindow(turn(1,100),true);repeated.flush();
for(let i=2;i<12;i++) {
 const previousFinal=[...repeated.contexts.values()].find(c=>c.id==='1:1').state.final;
 const row={event:{seq:100-i,time:i,type:'metadata',data:{turn:null}}};
 repeated.prepend([row],true);repeated.flush();
 const current=[...repeated.contexts.values()].find(c=>c.id==='1:1');
 assert.equal(current.state.final,current.matches.find(m=>m.event.type==='assistant/message'));
 assert.notEqual(current.state.final,previousFinal);
 assert.equal(Object.hasOwn(repeated,'replayContext'),false);
 assert.equal(Object.hasOwn(repeated,'buildNode'),false);
}
console.log('Repeated pagination releases transaction closures and rebinds retained Matches');

// Fresh assembly and checked-in production code execute the same retry reducer.
const freshCtx=vm.createContext({_xharness_dsh_client_runtime_client:runtime});
for(const name of ['contextLocation','chatNode']){const s=ui.indexOf(`function ${name}(`),e=ui.indexOf('\n\t\t}',s);vm.runInContext(ui.slice(s,e+4),freshCtx);}
const fs=fresh.indexOf('function scheduledNode('),fe=fresh.indexOf('function registerRetryConversationNode',fs);
vm.runInContext(fresh.slice(fs,fe)+'\nglobalThis.definition=retryDefinition;',freshCtx);
const freshAssembler=assembler(freshCtx.definition);freshAssembler.replaceWindow(rows.slice(4),true);freshAssembler.flush();
const shippedAssembler=assembler(ctx.definition);shippedAssembler.replaceWindow(rows.slice(4),true);shippedAssembler.flush();
assert.deepEqual(plain(freshAssembler.snapshot('chat')),plain(shippedAssembler.snapshot('chat')));
console.log('Fresh retry patch matches the shipped reducer');
