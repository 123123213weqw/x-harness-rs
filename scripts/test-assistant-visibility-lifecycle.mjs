// Regression for a real DeepSeek tool-only stream: partial JSON materializes
// an Assistant row, then complete JSON must hide (not withdraw) that same key.
// Both the assembler and Chat builder are the actual shipped factories.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {projectionArtifacts} from './projection-artifact-test.mjs'

const {runtime,conversation}=projectionArtifacts(['assistantDefinition','chatViewDefinition'])
const definition=conversation.assistantDefinition
const plain=value=>JSON.parse(JSON.stringify(value))
function assembler(def=definition) {
  return new runtime.ConversationNodeAssembler(
    {entries:()=>[def],fallbackEntry:()=>undefined},
    {entries:()=>[conversation.chatViewDefinition]},
  )
}
function trace(chunks,ending='final') {
  const rows=[]
  const add=(type,data)=>rows.push({event:{seq:rows.length+1,time:1000+rows.length,type,data}})
  add('turn/start',{turn:1});add('step/start',{turn:1,step:1})
  for(const chunk of chunks) {
    if(chunk.type==='retry') {
      add('llm/retry',{turn:1,step:1,retryId:'r',retry:1,delayMs:1,mode:'normal',maxRetries:2,provider:'fixture',policyKey:'network',failure:{code:'NETWORK',message:'offline'}})
    } else add('assistant/chunk',{turn:1,step:1,chunk})
  }
  if(ending==='final') add('assistant/message',{turn:1,step:1,message:{id:'final',content:[{type:'tool-call',id:'c',name:'bash',arguments:'{"command":"true"}'}]}})
  if(ending!=='open') {
    add('step/end',{turn:1,step:1})
    add('turn/end',{turn:1,reason:{kind:ending==='cancel'?'cancelled':'completed'}})
  }
  return rows
}
const delta=(argumentsDelta,index=0,id='c')=>({type:'tool-call-delta',index,id,name:'bash',argumentsDelta})
const complete={type:'block-end',index:0,block:{type:'tool-call',id:'c',name:'bash',arguments:'{"command":"true"}'}}
const partial=delta('{"command":')
const finish=delta('"true"}')
const captured=JSON.parse(readFileSync(new URL('./fixtures/deepseek-assistant-visibility.json',import.meta.url),'utf8'))
const corpora=[
  ['recorded DeepSeek argument-only continuation',captured.chunks],
  ['partial JSON becomes complete',[partial,finish]],
  ['empty-name argument continuation',[partial,{...delta('"tr'),name:''},{...delta('ue"}'),name:''}]],
  ['missing-name argument continuation',[partial,{...delta('"tr'),name:undefined},{...delta('ue"}'),name:undefined}]],
  ['block-end replaces partial',[partial,complete]],
  ['multiple calls hide and rematerialize',[partial,finish,delta('{',1,'d'),delta('}',1,'d')]],
  ['retry clears visible text',[{type:'text-delta',index:0,text:'old'}, {type:'retry'},partial,finish]],
  ['retry clears preparing tool',[partial,{type:'retry'},partial,finish]],
  ['retry starts with complete tool',[partial,{type:'retry'},delta('{}')]],
  ['tool before late reasoning',[partial,finish,{type:'reasoning-delta',index:1,text:'checked'}]],
  ['reasoning remains during complete tool',[{type:'reasoning-delta',index:1,text:'checked'},partial,finish]],
  ['never materialized complete tool',[delta('{}')]],
  ['empty and usage-only',[{type:'usage',usage:{inputTokens:10,outputTokens:0}}]],
]
let schedules=0,pages=0
const visibleSnapshot=a=>{
  const s=a.snapshot('chat')
  return plain({order:s.order,nodes:s.order.map(key=>s.nodes.get(key)),legacy:s.legacy})
}
for(const [name,chunks] of corpora) for(const ending of ['final','cancel','open']) {
  const input=trace(chunks,ending)
  const replay=assembler();replay.replaceWindow(input,false);replay.flush()
  const expected=visibleSnapshot(replay)
  // All frame batching partitions for these small, reachable streams. A
  // separate frame between partial and complete JSON is what old tests missed.
  const transitions=input.length-1
  for(let mask=0;mask<2**transitions;mask++) {
    const live=assembler();live.flush()
    for(let i=0;i<input.length;i++) {
      live.append(input[i])
      if(i===input.length-1 || mask & 2**i) live.flush()
      assert.equal(live.append(input[i]),'none','duplicate delivery')
    }
    assert.deepEqual(visibleSnapshot(live),expected,`${name}/${ending}/frame mask ${mask}`)
    schedules++
  }
  for(let split=0;split<=input.length;split++) {
    const paged=assembler();paged.replaceWindow(input.slice(split),split>0);paged.flush()
    paged.prepend(input.slice(0,split),false);paged.flush()
    assert.deepEqual(visibleSnapshot(paged),expected,`${name}/${ending}/page split ${split}`)
    pages++
  }
}

// Observe the hidden upsert and row ownership explicitly, not only the final
// snapshot (which could conceal a stale/duplicated preparing card).
const live=assembler();live.flush()
const input=trace([partial,finish,delta('{',1,'d'),delta('}',1,'d')],'open')
for(const row of input.slice(0,3)){live.append(row);live.flush()}
const key=live.snapshot('chat').order[0]
assert.ok(key);assert.equal(live.snapshot('chat').nodes.get(key).visibility,'visible')
live.append(input[3]);live.flush()
assert.deepEqual(plain(live.snapshot('chat').order),[])
assert.equal(live.snapshot('chat').nodes.get(key).visibility,'hidden')
live.append(input[4]);live.flush()
assert.deepEqual(plain(live.snapshot('chat').order),[key])
live.append(input[5]);live.flush()
assert.deepEqual(plain(live.snapshot('chat').order),[])
assert.equal(live.snapshot('chat').nodes.values().length,1,'no duplicate materialized row')

// Exact Host continuation shape observed in the real DeepSeek recording:
// tool_delta keeps an empty name on subsequent argument-only deltas. Partial
// content must still show the preparing card and preserve its call identity.
const continuation=assembler();continuation.flush()
const continued=trace([partial,{...delta('"tr'),id:'',name:''},{...delta('ue"}'),id:'',name:''}],'open')
for(const row of continued.slice(0,4)){continuation.append(row);continuation.flush()}
const continuedKey=continuation.snapshot('chat').order[0]
assert.ok(continuedKey)
const continuedBlock=continuation.snapshot('chat').nodes.get(continuedKey).data.blocks[0]
assert.equal(continuedBlock.name,'bash');assert.equal(continuedBlock.callId,'c')
assert.equal(continuedBlock.argsRaw,'{"command":"tr')
continuation.append(continued[4]);continuation.flush()
assert.deepEqual(plain(continuation.snapshot('chat').order),[])
assert.equal(continuation.snapshot('chat').nodes.get(continuedKey).visibility,'hidden')

// Never-materialized empty rows still stay absent; retries can hide a row
// without creating a phantom Assistant when there was no prior content.
for(const chunks of [[],[delta('{}')],[{type:'retry'}]]) {
  const empty=assembler();empty.flush()
  for(const row of trace(chunks,'open')){empty.append(row);empty.flush()}
  assert.equal(empty.snapshot('chat').nodes.values().length,0)
}

// Do not weaken the assembler's guard to fix one Definition. Deliberately
// withdrawing any previously materialized target must still be rejected.
const broken={...definition,buildViewNode:ctx=>ctx.matches.some(m=>m.event.type==='assistant/chunk'&&m.event.data.chunk.type==='tool-call-delta'&&m.event.data.chunk.argumentsDelta==='"true"}')?null:definition.buildViewNode(ctx)}
const bad=assembler(broken);bad.flush()
for(const row of input.slice(0,3)){bad.append(row);bad.flush()}
bad.append(input[3])
assert.throws(()=>bad.flush(),/withdrew materialized target "chat"/)

// The immutable pre-migration factory must actually fail on the captured
// provider stream. This proves sensitivity without changing its bytes or
// substituting a hand-written "old implementation" into production.
const baseline=projectionArtifacts(['assistantDefinition','chatViewDefinition'],'legacy')
const old=new baseline.runtime.ConversationNodeAssembler(
  {entries:()=>[baseline.conversation.assistantDefinition],fallbackEntry:()=>undefined},
  {entries:()=>[baseline.conversation.chatViewDefinition]},
)
old.flush()
assert.throws(()=>{
  for(const row of trace(captured.chunks,'open')){old.append(row);old.flush()}
},/Definition "assistant-step" withdrew materialized target "chat"/)
console.log(`assistant visibility lifecycle: ${schedules} frame partitions, ${pages} history page splits, stable hidden keys, duplicate delivery, retry/cancel/late reasoning and invariant rejection passed`)
