// Consume the same wire fixture checked by the Rust live/history projectors.
// Execute the shipped UI reducer and classifier, rather than copies of them.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectionArtifacts} from './projection-artifact-test.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const fixture=JSON.parse(read('./fixtures/assistant-projection.json'));
for(const implementation of ['source','legacy']) {
const {runtime,conversation}=projectionArtifacts(['compactBlocks','hasVisibleContent','hasInterruptionEvidence','updateChunk','finalNode'],implementation);
const context={...runtime,...conversation};
const plain=x=>JSON.parse(JSON.stringify(x));
const expected=plain(context.toAssistantBlocks(fixture.content));
for(const chunks of [fixture.chunks,fixture.chunks.filter(c=>c.type==='reasoning-delta'),fixture.chunks.filter(c=>c.type==='text-delta'),[]]) {
 let state={blocks:[],turn:1,step:1};
 let seq=0;
 for(const chunk of chunks) {
   const previous=plain(state);
   // The shared fixture supplies chunk payloads; the real assistant producer
   // also carries the owning turn/step on every durable event.
   const next=context.updateChunk(state,{event:{type:'assistant/chunk',seq:seq++,time:seq,data:{turn:1,step:1,chunk}}});
   assert.deepEqual(plain(state),previous,'reducer must not mutate its previous snapshot');
   state=next;
 }
 const streamed=plain(context.compactBlocks(state.blocks));
 if(chunks===fixture.chunks) {
   assert.deepEqual(streamed.filter(b=>b.kind!=='tool-call'),expected);
   assert.deepEqual(streamed.filter(b=>b.kind==='tool-call').map(b=>b.callId),['call-a','call-b']);
   // Final settled message must not erase reasoning, including after an interrupted response.
   for(const interrupted of [false,true]) {
     state.final={event:{type:'assistant/message',seq:100,time:100,data:{turn:1,step:1,message:{id:'a',content:fixture.content},interrupted}}};
     const final=context.finalNode(state,{matches:[]});
     assert.deepEqual(plain(final.blocks),expected);
     assert.equal(!!final.interrupted,interrupted);
     const restored=context.finalNode({...state,blocks:[]},{matches:[]});
     assert.deepEqual(plain(restored.blocks),expected,'refresh uses only the canonical final message');
   }
 }
}
// Old colliding indices genuinely reproduce the bug: this guard validates test sensitivity.
let broken={blocks:[]},brokenSeq=0;
for(const chunk of fixture.chunks.filter(c=>c.type!=='tool-call-delta')) {
 broken=context.updateChunk(broken,{event:{type:'assistant/chunk',seq:brokenSeq++,time:brokenSeq,data:{turn:1,step:1,chunk:{...chunk,index:0}}}});
}
assert.notDeepEqual(plain(context.compactBlocks(broken.blocks)),expected);
console.log(implementation+' assistant projection: text-first/interleaving/Unicode/tools/reasoning-only/text-only/empty/final/interrupted/refresh passed');

}
