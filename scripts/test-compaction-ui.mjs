import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const fixtures=JSON.parse(read('tests/fixtures/compaction-ui.json'));
const source=read('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js');
const start=source.indexOf('const COMPACT_PLUGIN = "compact";');
const end=source.indexOf('//#endregion',source.indexOf('function registerCompactionConversationNode',start));
assert.ok(start>=0 && end>start);
let expanded=false;
const jsx=(type,props)=>({type,props});
const env={
 react:{memo:fn=>fn,useState:()=>[expanded,fn=>{expanded=fn(expanded);}]},
 react_jsx_runtime:{jsx,jsxs:jsx}, MessageItem_module_css_default:{},
 _xharness_dsh_client_ui_primitives:{MarkdownText:'markdown'},
 _xharness_dsh_client_runtime_client:{isReplacementSurfaceEvent:e=>e.surfaceOp?.op==='replace'},
 chatNode:(_context,kind,seq,data)=>({kind,seq,data}),
};
const itemStart=source.indexOf('const CompactionItem =');
const itemEnd=source.indexOf('\n\t\t});',itemStart)+7;
vm.runInNewContext(source.slice(start,end)+'\n'+source.slice(itemStart,itemEnd)+'\nglobalThis.api={commandDefinition,compactionDefinition,compactSummary,CompactionItem};',env);
const api=env.api;
const t=(key,args)=>`${key}:${JSON.stringify(args??{})}`;
const find=(tree,predicate)=>{
 if(!tree || typeof tree!=='object')return undefined;
 if(predicate(tree))return tree;
 for(const child of [tree.props?.children].flat(2)) {const result=find(child,predicate);if(result)return result;}
};
assert.match(source,/data-compaction-running/);
assert.match(source,/t\("message\.compaction\.running"\)/);
for(const f of fixtures) {
 const matches=f.events.map(event=>({event}));
 const def=f.manual?api.commandDefinition:api.compactionDefinition;
 const relevant=matches.filter(m=>def.match(m.event));
 let view;
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
  const running=def.buildViewNode({state:runningState,matches:[startMatch]});
  assert.equal(running.kind,'compaction');
  assert.equal(running.data.status,'running');
  assert.equal(running.data.seq,startMatch.event.seq);
  assert.deepEqual(running,def.buildViewNode({matches:[startMatch]}),'running live and restored contribution agree');
  let state=def.start();
  for(const match of relevant) {
   state=def.update({state},match);
   state=def.update({state},match); // replay of an already delivered event
  }
  view=def.buildViewNode({state,matches:relevant});
  assert.deepEqual(view,def.buildViewNode({matches:relevant}),'live and restored contribution agree');
 }
 if(f.error) {assert.equal(view,null,'failed/cancelled compaction cannot appear as committed');continue;}
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
// Context inspector compatibility: evaluate its shipped component as well.
for(const path of ['ui/plugins/@xlang/xharness-client-ui-context/client.js','ui/dist/plugins/@xlang/xharness-client-ui-context/client.js']) {
 const s=read(path),a=s.indexOf('function CompactionBanner('),b=s.indexOf('\n    function ContextView',a);
 const ctx={h:(type,props,...children)=>({type,props,children}),numberOrUndefined:x=>x,fmtTokens:String};
 vm.runInNewContext(s.slice(a,b)+'\nglobalThis.banner=CompactionBanner',ctx);
 for(const summary of ['你好🧪',[{type:'text',text:'你'},{type:'image',text:'not text'},{type:'text',text:'好🧪'}]]) {
  const tree=ctx.banner({compaction:{summary,shadowedTokenCount:128}});
  assert.equal(tree.children[0][1].children[0],'你好🧪');
 }
}
assert.equal(read('ui/plugins/@xlang/xharness-client-ui-context/client.js'),read('ui/dist/plugins/@xlang/xharness-client-ui-context/client.js'));
console.log('compaction UI: automatic/manual, failure/cancel, replay/history, late summary, expand/collapse, counts and Context compatibility passed');
