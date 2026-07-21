// Latest master differential: actual strict production closure versus immutable a613970.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {compileSourceModules} from './build-source-modules.mjs'
import {exposeConversation,legacyConversation} from './conversation-artifact-test.mjs'
import {harness,json} from './conversation-test-harness.mjs'
const id='@xharness/dsh-client-ui-conversation';
const bytes=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id,source:'src/modules/conversation/index.ts'}]).get(id).bytes.toString();
const names=['compactProgress','compactLifecycle','compactionDefinition','commandDefinition','retryDefinition','updateRetryState'];
const apis=[legacyConversation().toString(),bytes].map(source=>harness(exposeConversation(source,names)).plugin);
const event=(type,data,seq=1)=>({type,data,seq,time:1000+seq});
const match=(event,view)=>({event,view,role:'update',location:{kind:'session'}});
const context=(definition,state,matches)=>({kind:definition.kind,key:'k',id:'r',state,matches,start:matches.find(row=>row.role==='start'),locations:[],target:'chat'});
const text=value=>[{type:'text',text:value}];

test('latest compaction progress: eight real stages, nullish metrics, exact counters and identity',()=>{
 const baseline={calls:2,completedParts:1,splits:1,retries:0};
 for(const stage of ['preparing','summarizing','splitting','merging','retrying','paused','validating','committing'])for(const metric of [undefined,null,0,25]){
  const value={stage,...baseline,delayMs:metric,inputTokensBefore:metric,inputTokensAfter:metric,foreign:'keep'};
  for(const api of apis)assert.equal(api.compactProgress(value),value,'valid progress preserves producer identity/foreign fields');
 }
 for(const value of [null,{}, {stage:'new',...baseline},{stage:'paused',...baseline,calls:-1},{stage:'paused',...baseline,completedParts:3},{stage:'paused',...baseline,retries:1.5},{stage:'paused',...baseline,splits:Number.MAX_SAFE_INTEGER+1},{stage:'paused',...baseline,delayMs:NaN}])for(const api of apis)assert.equal(api.compactProgress(value),undefined);
});

test('latest compaction: view forwarding/history-only success, pause/failure and terminal late-progress stability',()=>{
 const progress={stage:'paused',calls:1,completedParts:0,splits:0,retries:0,delayMs:25};
 const raw=[event('compaction/start',{compactionId:'c'},1),event('compaction/progress',{compactionId:'c',progress},2),event('compaction/end',{compactionId:'c',error:'network exhausted'},3),event('compaction/progress',{compactionId:'c',progress:{...progress,stage:'summarizing'}},4)];
 const traces=apis.map(api=>{const d=api.compactionDefinition,matches=[];let state=d.start();const trace=[];for(const e of raw){const m=match(e);if(d.match(e))matches.push(m);state=d.update({state},m);trace.push(json(d.buildViewNode(context(d,state,matches))))}return trace});
 assert.deepEqual(traces[1],traces[0]);assert.equal(traces[1][1].data.progress.stage,'paused');assert.equal(traces[1][2].data.status,'failed');assert.deepEqual(traces[1][3],traces[1][2],'late progress never resurrects a terminal compaction');
 const view={for:'compaction',view:{schemaVersion:1,id:'projected',phase:'succeeded',anchorSeq:11,time:1011,summary:'retained',summaryEventSeq:10,shadowedItemCount:1,shadowedTokenCount:30,foreign:'keep'}};
 const m=match(event('foreign/plugin',{},12),view);const outputs=apis.map(api=>{const d=api.compactionDefinition;assert.deepEqual(json(d.match(m.event,m.view)),{id:'projected',role:'update'});return json(d.buildViewNode(context(d,undefined,[m])))});
 assert.deepEqual(outputs[1],outputs[0]);assert.equal(outputs[1].data.summary,'retained');assert.equal(outputs[1].data.seq,11);
 for(const api of apis)assert.equal(api.compactionDefinition.match(m.event,{for:'compaction',view:{schemaVersion:99}}),null);
});

const scheduled=(retry,seq=retry)=>event('llm/retry',{retryId:'r',turn:1,step:2,provider:'p',policyKey:'xharness:network-wait',retry,delayMs:2000,mode:'always',failure:{code:'network',message:'offline'}},seq);
const started=(retry,seq=retry)=>event('llm/retry-started',{retryId:'r',turn:1,step:2,retry},seq);
test('latest network retry: producer correlation, replay, tail cuts, full/partial facts and cancellation',()=>{
 const corpora=[[scheduled(1),started(1,2),scheduled(2,3)], [started(4,10)], [started(4,10),scheduled(4,11)], [scheduled(1),scheduled(1),started(1,2),scheduled(1,3)]];
 for(const events of corpora){const outputs=apis.map(api=>{const d=api.retryDefinition,matches=[];let state;for(const e of events){const role=d.match(e).role,m={...match(e),role};matches.push(m);state=api.updateRetryState(state,m)}return json(d.buildViewNode(context(d,state,matches)))});assert.deepEqual(outputs[1],outputs[0]);assert.equal(outputs[1].data.attempts.length,new Set(events.map(e=>e.data.retry)).size)}
 for(const api of apis){const d=api.retryDefinition;assert.equal(d.historyReuse,'local');const m=match(started(7,20));const partial=d.buildViewNode(context(d,undefined,[m])).data.current;assert.equal(partial.partial,true);for(const fact of ['delayMs','maxRetries','failure','mode','policyKey'])assert.equal(partial[fact],undefined,'history cut must not invent '+fact);
 const e=scheduled(1),closed={kind:'step',turn:{turn:1,status:'closed'},step:{turn:1,step:2,status:'closed'}},m2={...match(e),location:closed,role:'start'},node=d.buildViewNode(context(d,undefined,[m2]));assert.equal(node.data.current.retryState,'cancelled');assert.equal(d.match(event('llm/retry-started',{retryId:'',turn:1,step:2,retry:1})),null)}
});
