// Contract regression over the real shipped ModuleLoader closure.
import assert from 'node:assert/strict';
import {verifyConversationArtifact,exposeConversation,legacyConversation} from './conversation-artifact-test.mjs';
import {harness,json} from './conversation-test-harness.mjs';
import {testHooks,descendants,barFixture} from './conversation-test-hooks.mjs';
const shipped=verifyConversationArtifact();
const items=[{id:'receipt',placement:'context',preview:'receipt',text:'receipt'},{id:'draft',placement:'queued',preview:'draft',text:'draft'},{id:'steered',placement:'steering',preview:'steered',text:'steered'},{id:'peer',placement:'context',preview:'peer',text:'peer'}];
for(const [label,source] of [['golden',legacyConversation().toString()],['native',shipped]]) {
 const hooks=testHooks(),{plugin:api}=harness(exposeConversation(source,['InputHub','QueueDock','InputBar']),{react:hooks.react,jsx:hooks.jsx,globals:{navigator:{userAgent:'test',vendor:''}}});
 let snapshot={queue:items,running:true,subagent:null};
 const render=()=>hooks.render(()=>api.QueueDock({useSession:select=>select(snapshot),t:key=>key,updateQueue:async()=>{},notify(){throw Error('unexpected notice')}}));
 let tree=render();assert.deepEqual(descendants(tree,node=>node.type==='li').map(node=>node.props.children.flat().filter(x=>x?.type==='span').map(x=>x.props.children).filter(x=>typeof x==='string')).flat(),['draft'],label+' must hide runtime context/steering receipts');
 descendants(tree,node=>node.props?.['aria-label']==='queue.edit')[0].props.onClick();tree=render();assert.equal(descendants(tree,node=>node.type==='input').length,1);
 snapshot={...snapshot,queue:items.map(item=>item.id==='draft'?{...item,placement:'context'}:item)};render();hooks.effects();snapshot={...snapshot,queue:items};tree=render();assert.equal(descendants(tree,node=>node.type==='input').length,0,'stale row must close its editor');
 let calls=[],notices=[];
 const owner={t:key=>key},session={getSnapshot:()=>({queue:items}),updateQueue:async(id,action)=>{calls.push({id,kind:action.kind});return {ok:true}}},shell={notify:(...args)=>notices.push(args)};
 await api.InputHub.prototype.steerQueue.call(owner,session,shell);assert.deepEqual(json(calls),[{id:'draft',kind:'steer'}]);
 calls=[];await api.InputHub.prototype.steerQueue.call(owner,{...session,getSnapshot:()=>({queue:items.filter(x=>x.placement==='context')})},shell);assert.deepEqual(calls,[]);
 for(const code of ['steer-unavailable','queue-item-not-found','transport-error']) {
  notices=[];await api.InputHub.prototype.steerQueue.call(owner,{...session,updateQueue:async()=>({ok:false,error:{code}})},shell);
  assert.equal(notices.length,code==='transport-error'?1:0);if(notices.length)assert.deepEqual(json(notices[0]),['error','queue.steerFailed']);
 }
 // Native owning composer dispatch: context-only accelerated Enter cannot steer.
 for(const queue of [items.filter(x=>x.placement==='context'),items]) {
  hooks.reset();let steered=0;const props=barFixture({draft:'',imageIds:[],phase:'plain',queue,occurrences:[],claim:null});
  props.keyboard={arbitrate:()=> 'pass',steerQueue:()=>steered++,submit:()=>{}};
  const bar=hooks.render(()=>api.InputBar(props)),textarea=descendants(bar,node=>node.type==='textarea')[0];
  textarea.props.onKeyDown({key:'Enter',ctrlKey:true,nativeEvent:{isComposing:false},preventDefault(){}});
  assert.equal(steered,queue===items?1:0,label+' empty composer queue ownership');
 }
}
console.log('internal queue: native + golden context isolation, stale edit, steer-only queued, races/failure and composer shortcut + freshness/hash/boot passed');

// Exercise the actual source folds with rich legacy events and slim identities.
const { createRequire } = await import('node:module');
const require = createRequire(new URL('../ui/package.json', import.meta.url));
const esbuild = require('esbuild');
async function sourceModule(path) {
 const built = await esbuild.build({entryPoints:[new URL(path,import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
 return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
}
const {SteeringHistory} = await sourceModule('../ui/src/modules/client-runtime/sessions/steering-history.ts');
const {nextStepInboxDefinition,nextTurnInboxDefinition} = await sourceModule('../ui/src/modules/conversation/conversation-nodes/inbox.ts');
const body=[{type:'text',text:'original Δ\n\\'}, {type:'image_ref',attachment:{attachmentId:'image'}},{type:'file',attachment:{attachmentId:'file'}}];
for(const rich of [false,true]) {
 const history=new SteeringHistory(), states=new Map();let seq=0;
 const identity=id=>rich?{id,content:body,source:{kind:'user'}}:{id};
 const splice=(target,start,removedCount,ids,outcome)=>{
  const data={target,start,removedCount,inserted:ids.map(identity),...(outcome?{outcome}:{})};
  const event={type:'agent/inbox/spliced',seq:seq++,time:100,data};
  history.apply(event);
  const def=target==='next-step'?nextStepInboxDefinition:nextTurnInboxDefinition;
  assert.ok(def.match(event),'source codec must accept old and new splice envelopes');
  states.set(def.kind,def.start({}, {event}, {previous:kind=>states.has(kind)?{state:states.get(kind)}:undefined}));
  for(const pending of states.get(def.kind).pending)assert.deepEqual(Object.keys(pending),['id'],'legacy bodies must not be retained by the UI identity fold');
 };
 const message=(id,kind='user')=>history.apply({type:'user/message',seq:seq++,time:100,data:{id,content:body,source:{kind}}});
 splice('next-turn',0,0,['queued']);splice('next-turn',0,1,[]);assert.equal(message('queued'),false);
 splice('next-step',0,0,['first','second']);splice('next-step',0,2,['second','first']);
 splice('next-step',0,1,[]);assert.equal(message('second'),true);assert.equal(message('second'),false);
 splice('next-step',0,1,[],'canceled');assert.equal(message('first'),false);
 assert.equal(states.get('inbox-next-step').claimed.has('first'),false);
 splice('next-step',0,0,['peer']);splice('next-step',0,1,[]);assert.equal(message('peer','subagent'),false);
 splice('next-step',0,0,['reset']);history.reset();assert.equal(message('reset'),false);
 assert.deepEqual(body,[{type:'text',text:'original Δ\n\\'},{type:'image_ref',attachment:{attachmentId:'image'}},{type:'file',attachment:{attachmentId:'file'}}]);
}
console.log('slim inbox: rich/slim source codec, queue, steering, reorder, cancellation, attachments, repeat and reset parity passed');
