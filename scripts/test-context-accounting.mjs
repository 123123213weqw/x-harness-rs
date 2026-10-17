import {sharedVendors} from './fixtures/shared-source-vendors.mjs'
import {verifyConversationArtifact,legacyConversation} from './conversation-artifact-test.mjs';
import {verifyConnectionArtifact,exposeConnection} from './connection-artifact-test.mjs';
import {conversationFixture} from './fixtures/conversation-source-fixture.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {patchContextAccounting, patchContextMeterStability} from './patch-context-accounting.mjs';
import {patchContextComposition, patchContextCompositionConnection} from './patch-context-composition.mjs';
const bytes=readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js',import.meta.url));
const native=bytes.toString().startsWith('// Generated');if(native)verifyConversationArtifact();const golden=legacyConversation();
assert.equal(patchContextAccounting(golden).toString(),golden.toString());
assert.equal(patchContextMeterStability(golden).toString(),golden.toString());
assert.equal(patchContextComposition(golden).toString(),golden.toString());
const source=bytes.toString().match(/function contextOccupancy\(pressure\) \{[\s\S]*?\n\t\t\}/)?.[0];if(!native)assert.ok(source);
const fn=native?conversationFixture(bytes.toString(),['contextOccupancy']).api.contextOccupancy:vm.runInNewContext('('+source+')');
let x=fn({pressureTokens:117446,projectedTokens:415395,contextWindow:1000000});assert.equal(x.usedTokens,117446);assert.equal(x.percent,12);assert.equal(x.exact,true);
x=fn({projectedTokens:415395,contextWindow:1000000,accuracy:'estimated'});assert.equal(x.exact,false);assert.match(x.label,/估算/);
x=fn({projectedTokens:117446,contextWindow:1000000,accuracy:'exact_request'});assert.equal(x.exact,true);
for(const p of [{}, {projectedTokens:1,contextWindow:0},{projectedTokens:NaN,contextWindow:1},{pressureTokens:-1,contextWindow:100}])assert.equal(fn(p),null);
assert.equal(fn({pressureTokens:0,contextWindow:100}).usedTokens,0);
console.log('context accounting: actual/estimate/unknown/zero/capacity/idempotence passed');
const connection=readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-connection/client.js',import.meta.url),'utf8');
const connectionGolden=readFileSync(new URL('../ui/reference/master-a613970/plugins/@xharness/dsh-client-connection/client.js',import.meta.url));assert.equal(patchContextCompositionConnection(connectionGolden).toString(),connectionGolden.toString());
const replaySource=connection.slice(connection.indexOf('function contextPressureOf(log) {'),connection.indexOf('\n\t\tfunction projectionValuesOf'));
let connectionRegistration;let replay;if(connection.startsWith('// Generated')){vm.runInNewContext(exposeConnection(verifyConnectionArtifact(),['contextPressureOf']),{window:{__ModuleLoader__:{load:r=>connectionRegistration=r}},console,URL,AbortController,setTimeout,clearTimeout});replay=connectionRegistration.factory(id=>id==='zod'?sharedVendors.zod:id==='@xharness/cordis'?{Service:class{}}:{}).contextPressureOf;}else replay=vm.runInNewContext('('+replaySource+')',{usageSampleOf:e=>e.type==='assistant/chunk'?{...e.data,usage:e.data.chunk.usage}:undefined});
const event=(type,data)=>({type,data});
const start=step=>event('step/start',{turn:1,step});
const usage=(step,n)=>event('assistant/chunk',{turn:1,step,chunk:{type:'usage',usage:{inputTokens:n,cacheReadTokens:100,outputTokens:0}}});
const history=[start(1),event('request/header',{header:{options:{tokenBudget:{contextWindowTokens:1000,estimate:{totalInputTokens:600}}}}}),usage(1,200)];
assert.equal(replay(history).pressureTokens,300);
assert.equal(replay([...history,start(2),usage(1,900)]).pressureTokens,undefined);
assert.equal(replay([...history,event('session/model-selected',{}),event('user/message',{}),usage(1,900)]).pressureTokens,undefined);
const composition={systemTokens:10,userTokens:20,assistantTokens:30,toolResultTokens:5,toolDefinitionTokens:10,protocolTokens:2,totalInputTokens:77,accuracy:'estimated'};
const composed=[start(1),event('request/header',{header:{options:{tokenBudget:{contextWindowTokens:1000,estimate:{totalInputTokens:77}},contextComposition:composition}}})];
assert.equal(JSON.stringify(replay(composed).composition),JSON.stringify(composition));
assert.equal(replay([...composed,start(2)]).composition,undefined);
console.log('context replay: new request / stale usage / model switch passed');
// Precision belongs to each reading. A provider usage must not promote an estimate.
for(const accuracy of ['estimated','calibrated']) {
 const h=[start(1),event('request/header',{header:{options:{tokenBudget:{contextWindowTokens:1000,accuracy,estimate:{totalInputTokens:600}}}}}),usage(1,200)];
 let p=replay(h);
 assert.equal(p.pressureAccuracy,'provider_reported');assert.equal(p.projectedAccuracy,accuracy);
 assert.equal(fn(p).accuracy,'provider_reported');
 p={...p,pressureTokens:undefined};
 assert.equal(fn(p).exact,false);assert.equal(fn(p).accuracy,accuracy);
 const stale=replay([...h,event('compaction/summary',{}),usage(1,200)]);
 assert.equal(stale.phase,'history_changed');assert.equal(fn(stale).stale,true);assert.match(fn(stale).label,/历史已变化/);
 assert.equal(stale.projectedTokens,600,'no invented post-compaction prediction');
}
const noUsage=replay([start(1),event('request/header',{header:{options:{tokenBudget:{context_window_tokens:1000,accuracy:'exact_tokenizer',estimate:{total_input_tokens:200}}}}}),event('turn/end',{})]);
assert.equal(noUsage.phase,'unmeasured');assert.equal(fn(noUsage).exact,true);assert.equal(noUsage.pressureTokens,undefined);
assert.equal(fn({projectedTokens:100,contextWindow:1000,accuracy:'provider_reported'}).exact,false,'legacy shared accuracy cannot turn a preflight estimate into an exact count');
assert.equal(fn({projectedTokens:1100,contextWindow:1000,projectedAccuracy:'estimated'}).percent,100);
console.log('context precision: independent readings / calibrated / compaction / late usage / legacy / failed request passed');

// The composer control must retain the same 28px slot while a new step clears
// the previous sample, and it must not present the old model's percentage.
const bundle=bytes.toString();
const meterStart=bundle.indexOf('function ContextMeter({ useProjection, t }) {');
const meterEnd=bundle.indexOf('\n\t\t//#endregion',meterStart);
if(!native)assert.ok(meterStart>=0&&meterEnd>meterStart);
const jsx=(type,props,key)=>({type,props,key});
const createElement=(type,props,...children)=>({type,props:{...props,children:children.length===1?children[0]:children}});
let meter;const meterEnv={
  contextOccupancy:fn,
  react:{createElement,useState:()=>[false,()=>{}],useRef:()=>({current:null}),useEffect:()=>{}},
  react_jsx_runtime:{jsx,jsxs:jsx},
  _xharness_dsh_client_ui_primitives:{Tooltip:'Tooltip'},
  ContextMeter_module_css_default:{root:'root',trigger:'trigger',track:'track',fill:'fill'},
  RADIUS:5.5,CIRCUMFERENCE:2*Math.PI*5.5,READING_SLOT:'\0',ROWS:[],formatTokens:n=>String(n),
};
meter=native?conversationFixture(bundle,['ContextMeter'],{react:meterEnv.react,primitives:new Proxy({Tooltip:'Tooltip'},{get:(target,key)=>target[key]??key})}).api.ContextMeter:vm.runInNewContext('('+bundle.slice(meterStart,meterEnd)+')',meterEnv);
const zh={
  'context.aria':'上下文已用 {percent}',
  'context.pending':'正在计算上下文',
  'context.unavailable':'暂无上下文读数',
};
function renderMeter(pressure,locale=zh) {
  const tree=meter({useProjection:key=>key==='contextPressure'?pressure:undefined,
    t:(key,params)=>locale[key]?.replace('{percent}',params?.percent??'')??key});
  assert.equal(tree.type,'span','the composer slot must never disappear');
  const tooltip=tree.props.children[0];
  const button=tooltip.props.children;
  const circle=[button.props.children.props.children].flat(3).find(child=>child?.props?.strokeDasharray!==undefined);
  assert.ok(circle,'rendered SVG must have a real fill ring');
  return {tree,tooltip,button,circle};
}
const pending=renderMeter({contextWindow:1000,phase:'preparing'});
assert.equal(pending.button.props.disabled,true);
assert.equal(pending.button.props['aria-label'],'正在计算上下文');
assert.equal(pending.button.props['aria-haspopup'],undefined);
assert.match(pending.circle.props.strokeDasharray,/^0 /);
const estimate=renderMeter({contextWindow:1000,projectedTokens:400,projectedAccuracy:'estimated',phase:'in_flight'});
assert.equal(estimate.button.props.disabled,false);
assert.equal(estimate.button.props['aria-label'],'上下文已用 ≈40%');
assert.match(estimate.circle.props.strokeDasharray,/^[1-9]/);
const nextStep=renderMeter({contextWindow:1000,phase:'preparing'});
assert.equal(nextStep.tree.props.className,estimate.tree.props.className);
assert.equal(nextStep.button.props.disabled,true,'never reuse the previous step as current');
assert.doesNotMatch(nextStep.button.props['aria-label'],/40%/);
const changedModel=renderMeter({});
assert.equal(changedModel.button.props.disabled,true);
assert.equal(changedModel.button.props['aria-label'],'暂无上下文读数');
const missingCapacity=renderMeter({pressureTokens:500,composition:{systemTokens:50,totalInputTokens:50,accuracy:'estimated'}});
assert.equal(missingCapacity.button.props.disabled,true,'composition alone cannot establish capacity');
assert.match(missingCapacity.circle.props.strokeDasharray,/^0 /);
const failed=renderMeter({contextWindow:1000,phase:'unmeasured'});
assert.equal(failed.button.props.disabled,true);
const measured=renderMeter({contextWindow:1000,pressureTokens:500,pressureAccuracy:'provider_reported'});
assert.equal(measured.button.props['aria-label'],'上下文已用 50%');
const split=renderMeter({contextWindow:1000,pressureTokens:500,pressureAccuracy:'provider_reported',composition:{
  systemTokens:10,userTokens:20,assistantTokens:30,toolResultTokens:20,toolDefinitionTokens:15,protocolTokens:5,totalInputTokens:100,accuracy:'estimated'
}});
const arcs=split.button.props.children.props.children.slice(1).flat(2);
assert.equal(arcs.length,6);
assert.equal(arcs[0].props.stroke,'#8290a5');
assert.equal(arcs[1].props.stroke,'#3b82f6');
assert.equal(arcs[2].props.stroke,'#20a887');
assert.equal(arcs[3].props.stroke,'#e1a63b');
assert.equal(arcs[4].props.stroke,'#a78bfa');
assert.equal(arcs[5].props.stroke,'#9b9b9b');
assert.equal(arcs.reduce((sum,arc)=>sum+Number(arc.props.strokeDasharray.split(' ')[0]),0),Math.PI*5.5);
const en=renderMeter({}, {'context.aria':'{percent} of context used',
  'context.pending':'Calculating context usage','context.unavailable':'Context usage unavailable'});
assert.equal(en.button.props['aria-label'],'Context usage unavailable');
assert.match(bundle,/['"]context\.pending['"]:\s*['"]正在计算上下文['"]/);
assert.match(bundle,/['"]context\.pending['"]:\s*['"]Calculating context usage['"]/);
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url)));
const entry=graph.entries.find(item=>item.id==='@xharness/dsh-client-ui-conversation');
assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));
const html=readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8');
assert.ok(html.includes(entry.url));
console.log('context meter: stable slot / no stale reading / unavailable / measured / bilingual / revision passed');

// Authorship is independent of role, and old role-only snapshots are never
// relabelled as human-authored. Execute the actual shipped expanded panel.
const expanded=conversationFixture(bundle,['ContextMeter','en'],{react:{useState:()=>[true,()=>{}]}}).api;
function textOf(node) {
  if(node===null||node===undefined||typeof node==='boolean')return '';
  if(typeof node==='string'||typeof node==='number')return String(node);
  if(Array.isArray(node))return node.map(textOf).join('');
  return textOf(node.props?.children);
}
function descendants(node,type,result=[]) {
  if(Array.isArray(node)){for(const child of node)descendants(child,type,result);return result;}
  if(!node||typeof node!=='object')return result;
  if(node.type===type)result.push(node);
  descendants(node.props?.children,type,result);return result;
}
function categoryPanel(composition) {
 const tree=expanded.ContextMeter({useProjection:()=>({contextWindow:1000,pressureTokens:500,pressureAccuracy:'provider_reported',composition}),t:key=>expanded.en[key]??key});
 const labels=descendants(tree,'dt').map(textOf), amounts=descendants(tree,'dd').map(textOf);
 return {tree,labels,amounts};
}
const origins={attributionVersion:2,systemTokens:5,userTokens:2,agentReportTokens:40,runtimeContextTokens:20,checkpointTokens:10,unattributedTokens:3,assistantTokens:10,toolResultTokens:5,toolDefinitionTokens:4,protocolTokens:1,totalInputTokens:100,accuracy:'estimated'};
const authored=categoryPanel(origins);
assert.deepEqual(authored.labels,['System prompt','Your messages','Agent reports','Runtime context','Checkpoints','Unattributed context','Assistant','Tool results','Tools','Protocol overhead']);
assert.equal(authored.amounts[1],'≈10');assert.equal(authored.amounts[2],'≈200');
assert.equal(authored.amounts.reduce((sum,value)=>sum+Number(value.slice(1)),0),500,'rows scale to the measured total, not cumulative billing');
const legacyPanel=categoryPanel(composition);
assert.ok(legacyPanel.labels.includes('User-role history (source unknown)'));
assert.ok(!legacyPanel.labels.includes('Your messages'),'legacy role totals cannot claim human authorship');
const absentHuman=categoryPanel({...origins,userTokens:0});
assert.ok(!absentHuman.labels.includes('Your messages'));
assert.ok(absentHuman.labels.includes('Agent reports'));
const invalidPanel=categoryPanel({...origins,userTokens:NaN,agentReportTokens:Infinity,runtimeContextTokens:-1});
assert.ok(!invalidPanel.labels.includes('Your messages'));assert.ok(!invalidPanel.labels.includes('Agent reports'));assert.ok(!invalidPanel.labels.includes('Runtime context'));
const newEvents=[start(1),event('request/header',{header:{options:{tokenBudget:{contextWindowTokens:1000,estimate:{totalInputTokens:100}},contextComposition:origins}}}),usage(1,400),event('user/message',{})];
const newReplay=replay(newEvents);
assert.equal(JSON.stringify(newReplay.composition),JSON.stringify(origins));
assert.equal(newReplay.pressureTokens,500);assert.equal(newReplay.phase,'history_changed');
assert.equal(replay([...newEvents,start(2)]).composition,undefined);
console.log('context provenance: human / agent / runtime / checkpoint / unknown / legacy / invalid / measured total / replay passed');
