/** Real Session + assembler + complete Conversation classifiers, not copied reducers. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
import {loadOwnedCordisRuntime} from './fixtures/owned-view-cordis-runtime.mjs'
const Core=loadOwnedCordisRuntime(),runtimeId='@xharness/dsh-client-runtime',conversationId='@xharness/dsh-client-ui-conversation'
const compiled=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id:runtimeId,source:'src/modules/client-runtime/test-exports.ts'},{id:conversationId,source:'src/modules/client-runtime/history-browser-exports.ts'}])
function evaluate(code,externals){let row;const document={querySelector:()=>null,getElementById:()=>null,createElement:()=>({dataset:{}}),head:{appendChild(){}}};vm.runInNewContext(code,{window:{__ModuleLoader__:{load:value=>row=value}},document,console,AbortController,AbortSignal,Date,URL,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame:callback=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout});return row.factory(name=>{if(name in externals)return externals[name];throw Error('unexpected external '+name)})}
const react={createElement:(type,props)=>({type,props}),memo:x=>x,createContext:initial=>({value:initial}),useState:value=>[value,()=>{}]},jsx=(type,props)=>({type,props})
const raw=(type,data,seq)=>({event:{seq,time:seq,type,data}}),user=seq=>({...raw('user/message',{id:'u'+seq,source:{kind:'user'},content:[{type:'text',text:'retained'}]},seq),event:{...raw('user/message',{id:'u'+seq,source:{kind:'user'},content:[{type:'text',text:'retained'}]},seq).event,surfaceOp:'append'}})
for(const implementation of ['legacy','source']){
 test(`${implementation}: malformed known compaction rolls back real history and preserves retry/pending state`,async()=>{
  const frozen=id=>readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8')
  const runtime=evaluate(implementation==='source'?compiled.get(runtimeId).bytes.toString():frozen(runtimeId).replace('exports.apply = apply;','exports.Session = Session; exports.apply = apply;'),{'@xharness/cordis':Core,'@xharness/dsh-client-ui-slots':{resolveSlotLabel:value=>value},react})
  const conversation=evaluate(implementation==='source'?compiled.get(conversationId).bytes.toString():frozen(conversationId).replace('exports.apply = apply;','exports.registerConversationNodes = registerConversationNodes; exports.apply = apply;'),{'@xharness/cordis':Core,'@xharness/dsh-client-runtime/client':runtime,'react':react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'@xharness/dsh-client-ui-primitives':new Proxy({},{get:(_o,key)=>String(key)}),'@xharness/dsh-client-ui-slots':{resolveSlotLabel:value=>value}})
  const definitions=[],views=[];let fallback;conversation.registerConversationNodes({conversationEvents:{register:definition=>definitions.push(definition),registerFallback:definition=>fallback=definition},conversationViews:{register:definition=>views.push(definition)}})
  const registry={events:{entries:()=>definitions,fallbackEntry:()=>fallback},views:{entries:()=>views}}
  let invalid=false,calls=0;const bad=[raw('compaction/summary',{compactionId:'broken'},2),raw('compaction/start',{compactionId:'broken'},3)]
  const api={sessions:{history:async()=>{calls++;return{result:{ok:true,value:{events:invalid?[user(1),...bad]:[user(1)],hasMore:false}}}}}}
  const session=new runtime.Session('atomic',api,{}, {conversation:registry});await session.open();const before=session.events,snapshot=session.conversation.snapshot('chat');assert.equal(session.openState,'open');assert.equal(snapshot.order.length,1)
  const pending={kind:'question',id:'keep'};session.pending.set('question:keep',pending);session.pendingRev++;const revision=session.pendingRev
  invalid=true;await session.resync();assert.equal(session.events,before,'raw history transaction rolls back');assert.equal(session.conversation.snapshot('chat'),snapshot,'entire published chat identity rolls back');assert.equal(session.openState,'error');assert.ok(session.openError);assert.equal(session.pending.get('question:keep'),pending);assert.equal(session.pendingRev,revision)
  invalid=false;await session.loadOlder();assert.equal(session.openState,'open');assert.equal(session.openError,null);assert.equal(session.pending.get('question:keep'),pending);assert.equal(session.pendingRev,revision);assert.equal(calls,3)
  session.installWindow([user(1),raw('foreign/retained',{foreign:{nested:['kept']}},4)],false);assert.equal(session.events.at(-1).type,'foreign/retained');assert.equal(session.getSnapshot().chat.order.length,1,'non-surface foreign history retains the original classifier visibility');assert.deepEqual(JSON.parse(JSON.stringify(session.events.at(-1).data)),{foreign:{nested:['kept']}},'open carrier retains all foreign payload fields')
 })
}
