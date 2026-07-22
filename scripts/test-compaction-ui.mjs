import {verifyConversationArtifact} from './conversation-artifact-test.mjs';
import {conversationFixture} from './fixtures/conversation-source-fixture.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const fixtures=JSON.parse(read('tests/fixtures/compaction-ui.json'));
const source=read('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js');
const start=source.indexOf('// xh-compaction-progress/v1');
const end=source.indexOf('//#endregion',source.indexOf('function registerCompactionConversationNode',start));
const native=source.startsWith('// Generated from src/modules/conversation/');if(native)verifyConversationArtifact();else assert.ok(start>=0 && end>start);
let expanded=false;
const jsx=(type,props)=>({type,props});
const env={
 react:{memo:fn=>fn,useRef:value=>({current:value}),useState:()=>[expanded,value=>{expanded=typeof value==='function'?value(expanded):value;}]},
 react_jsx_runtime:{jsx,jsxs:jsx}, MessageItem_module_css_default:{},
 _xharness_dsh_client_ui_primitives:{MarkdownText:'markdown'},
 _xharness_dsh_client_runtime_client:{isReplacementSurfaceEvent:e=>e.surfaceOp?.op==='replace'},
 chatNode:(_context,kind,seq,data,options={})=>({kind,seq,data,visibility:options.visibility??'visible'}),
};
const itemStart=source.indexOf('const CompactionItem =');
const itemEnd=source.indexOf('\n\t\t});',itemStart)+7;
if(native)env.api=conversationFixture(source,['commandDefinition','compactionDefinition','compactSummary','CompactionItem'],{react:env.react,primitives:new Proxy({MarkdownText:'markdown'},{get:(target,key)=>target[key]??key})}).api;
else {
 // Include the shipped no-provider row-state hook, not a replacement hook.
 const hookStart=source.indexOf('function xhUseTranscriptState(key, initial)');
 const hookEnd=source.indexOf('\n}',hookStart)+2;
 assert.ok(hookStart>=0 && hookEnd>hookStart,'shipped transcript state bridge exists');
 vm.runInNewContext(source.slice(hookStart,hookEnd)+'\n'+source.slice(start,end)+'\n'+source.slice(itemStart,itemEnd)+'\nglobalThis.api={commandDefinition,compactionDefinition,compactSummary,CompactionItem};',env);
}
const api=env.api;
const t=(key,args)=>`${key}:${JSON.stringify(args??{})}`;
const find=(tree,predicate)=>{
 if(!tree || typeof tree!=='object')return undefined;
 if(predicate(tree))return tree;
 for(const child of [tree.props?.children].flat(2)) {const result=find(child,predicate);if(result)return result;}
};
assert.match(source,/data-compaction-running/);
assert.match(source,/t\(["']message\.compaction\.running["']\)/);
assert.match(source,/xh-compaction-view-model\/v2/);
assert.match(read('ui/dist/plugins/@xharness/dsh-client-runtime/client.js'),/definition\.match\(input\.event, input\.view\)/);
for(const f of fixtures) {
 const matches=f.events.map(event=>({event}));
 const def=f.manual?api.commandDefinition:api.compactionDefinition;
 const relevant=matches.filter(m=>def.match(m.event));
 let view, running;
 if(f.manual) {
  // The manual checkpoint can rebuild its command identity even when the
  // page starts after command/run. The automatic contribution must ignore it.
  assert.ok(matches.every(m=>api.compactionDefinition.match(m.event)===null));
  view=def.buildViewNode({matches:relevant});
  assert.equal(view.kind,'manual-compaction');
  assert.equal(view.data.command.commandId,'manual-compact');
 } else {
  const startMatch=relevant.find(m=>m.event.type==='compaction/start');
  const runningState=def.update({state:def.start()},startMatch);
  running=def.buildViewNode({state:runningState,matches:[startMatch]});
  assert.equal(running.kind,'compaction');
  assert.equal(running.data.status,'running');
  assert.equal(running.data.seq,startMatch.event.seq);
  assert.equal(running.visibility,'visible');
  assert.deepEqual(running,def.buildViewNode({matches:[startMatch]}),'running live and restored contribution agree');
  let state=def.start();
  for(const match of relevant) {
   state=def.update({state},match);
   state=def.update({state},match); // replay of an already delivered event
  }
  view=def.buildViewNode({state,matches:relevant});
  assert.deepEqual(view,def.buildViewNode({matches:relevant}),'live and restored contribution agree');
 }
 if(f.error) {
  assert.equal(view.visibility,'visible','failed/cancelled compaction remains visible with unchanged-history feedback');
  assert.equal(view.data.status,'failed');
  assert.equal(view.seq,running.seq,'the hidden update retains the running node identity');
  continue;
 }
 const node=f.manual?view.data.compaction:view.data;
 assert.equal(node.summary,'## 摘要\n保留任务 🧪');
 assert.equal(node.shadowedItemCount,1);assert.equal(node.shadowedTokenCount,128);
 expanded=false;
 let tree=api.CompactionItem({node,t});
 const button=find(tree,x=>x.type==='button');
 assert.equal(button.props.disabled,false);assert.equal(button.props['aria-expanded'],false);
 assert.equal(find(tree,x=>x.type==='markdown'),undefined);
 button.props.onClick();tree=api.CompactionItem({node,t});
 assert.equal(find(tree,x=>x.type==='button').props['aria-expanded'],true);
 assert.equal(find(tree,x=>x.type==='markdown').props.text,node.summary);
 find(tree,x=>x.type==='button').props.onClick();
 assert.equal(find(api.CompactionItem({node,t}),x=>x.type==='markdown'),undefined);
 const missing=api.compactSummary(undefined,matches.find(m=>m.event.surfaceOp?.op==='replace'));
 assert.equal(find(api.CompactionItem({node:missing,t}),x=>x.type==='button').props.disabled,true);
 // A delayed summary, after checkpoint/history page recovery, enables expand.
 assert.equal(api.compactSummary(matches.find(m=>m.event.type==='compaction/summary'),matches.find(m=>m.event.surfaceOp?.op==='replace')).summary,node.summary);
}
// A product-owned view can rebuild a committed marker even when a history
// page contains only compaction/end. Raw lifecycle fields are not read here.
const projectedStart={event:{type:'xharness/internal',seq:20,time:100,data:{}},view:{for:'compaction',view:{schemaVersion:1,id:'from-view',phase:'running',anchorSeq:20,time:100}}};
const projectedDone={event:{type:'xharness/internal',seq:23,time:104,data:{}},view:{for:'compaction',view:{schemaVersion:1,id:'from-view',phase:'succeeded',anchorSeq:22,time:103,summary:'摘要',summaryEventSeq:21,shadowedItemCount:1,shadowedTokenCount:128}}};
const projectedFailure={event:{type:'xharness/internal',seq:23,time:104,data:{}},view:{for:'compaction',view:{schemaVersion:1,id:'from-view',phase:'failed',anchorSeq:20,time:100}}};
for(const match of [projectedStart,projectedDone,projectedFailure])
 assert.equal(api.compactionDefinition.match(match.event,match.view).id,'from-view');
let projectedState=api.compactionDefinition.start({},projectedStart);
assert.equal(api.compactionDefinition.buildViewNode({state:projectedState,matches:[projectedStart]}).data.status,'running');
projectedState=api.compactionDefinition.update({state:projectedState},projectedDone);
assert.equal(api.compactionDefinition.buildViewNode({state:projectedState,matches:[projectedStart,projectedDone]}).data.summary,'摘要');
assert.equal(api.compactionDefinition.buildViewNode({matches:[projectedDone]}).data.summary,'摘要');
const failedState=api.compactionDefinition.update({state:api.compactionDefinition.start({},projectedStart)},projectedFailure);
assert.equal(api.compactionDefinition.buildViewNode({state:failedState,matches:[projectedStart,projectedFailure]}).visibility,'visible');
assert.equal(api.compactionDefinition.match(projectedFailure.event,{for:'compaction',view:{schemaVersion:99}}),null);
// Context inspector compatibility: execute the full canonical factory's own scope.
const {sourceDeclaration}=await import('./fixtures/source-declaration.mjs');
const {assertRebuildInput}=await import('./fixtures/repository-ui-input.mjs');
const {artifactUnitScope}=await import('./fixtures/context-artifact-scope.mjs');
const {verifyArtifact}=await import('./fixtures/shipped-source-values.mjs');
const contextId='@xlang/xharness-client-ui-context';
for(const path of [`ui/reference/master-a613970/plugins/${contextId}/client.js`,`ui/dist/plugins/${contextId}/client.js`]) {
 const s=read(path);
 let banner;
 if(s.startsWith('// Generated')) {
  assert.equal(s,verifyArtifact(contextId),'canonical Context must be strict-source fresh');
  const unit='src/modules/context/index.js',h=(type,props,...children)=>({type,props,children});let registration;
  const scoped=artifactUnitScope({source:s,root:unit},{CompactionBanner:{unit,member:'CompactionBanner'}},{[unit]:['CompactionBanner']});
  vm.runInNewContext(scoped,{window:{__ModuleLoader__:{load:row=>{registration=row}}},console});
  const react={createElement:h,useEffect(){},useMemo:fn=>fn(),useState:value=>[value,()=>{}]};
  banner=registration.factory(name=>{assert.equal(name,'react','Context has only its real React external');return react}).CompactionBanner;
 } else {
  const ctx={h:(type,props,...children)=>({type,props,children}),numberOrUndefined:x=>x,fmtTokens:String,asObject:x=>x};
  vm.runInNewContext(sourceDeclaration(s,'CompactionBanner')+'\nglobalThis.banner=CompactionBanner',ctx);banner=ctx.banner;
 }
 for(const summary of ['你好🧪',[{type:'text',text:'你'},{type:'image',text:'not text'},{type:'text',text:'好🧪'}]]) {
  const tree=banner({compaction:{kind:'compaction',seq:1,time:1,summary,shadowedTokenCount:128}});
  assert.equal(tree.children[0][1].children[0],'你好🧪');
 }
}
assertRebuildInput(contextId);
console.log('compaction UI: automatic/manual, failure/cancel, replay/history, late summary, expand/collapse, counts and Context compatibility passed');
