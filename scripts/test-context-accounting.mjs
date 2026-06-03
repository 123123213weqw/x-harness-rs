import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {patchContextAccounting, patchContextMeterStability} from './patch-context-accounting.mjs';
const bytes=readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js',import.meta.url));
assert.equal(patchContextAccounting(bytes).toString(),bytes.toString());
assert.equal(patchContextMeterStability(bytes).toString(),bytes.toString());
const source=bytes.toString().match(/function contextOccupancy\(pressure\) \{[\s\S]*?\n\t\t\}/)?.[0];assert.ok(source);
const fn=vm.runInNewContext('('+source+')');
let x=fn({pressureTokens:117446,projectedTokens:415395,contextWindow:1000000});assert.equal(x.usedTokens,117446);assert.equal(x.percent,12);assert.equal(x.exact,true);
x=fn({projectedTokens:415395,contextWindow:1000000,accuracy:'estimated'});assert.equal(x.exact,false);assert.match(x.label,/估算/);
x=fn({projectedTokens:117446,contextWindow:1000000,accuracy:'exact_request'});assert.equal(x.exact,true);
for(const p of [{}, {projectedTokens:1,contextWindow:0},{projectedTokens:NaN,contextWindow:1},{pressureTokens:-1,contextWindow:100}])assert.equal(fn(p),null);
assert.equal(fn({pressureTokens:0,contextWindow:100}).usedTokens,0);
console.log('context accounting: actual/estimate/unknown/zero/capacity/idempotence passed');
const connection=readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-connection/client.js',import.meta.url),'utf8');
const replaySource=connection.slice(connection.indexOf('function contextPressureOf(log) {'),connection.indexOf('\n\t\tfunction projectionValuesOf'));
const replay=vm.runInNewContext('('+replaySource+')',{usageSampleOf:e=>e.type==='assistant/chunk'?{...e.data,usage:e.data.chunk.usage}:undefined});
const event=(type,data)=>({type,data});
const start=step=>event('step/start',{turn:1,step});
const usage=(step,n)=>event('assistant/chunk',{turn:1,step,chunk:{usage:{inputTokens:n,cacheReadTokens:100}}});
const history=[start(1),event('request/header',{header:{options:{tokenBudget:{contextWindowTokens:1000,estimate:{totalInputTokens:600}}}}}),usage(1,200)];
assert.equal(replay(history).pressureTokens,300);
assert.equal(replay([...history,start(2),usage(1,900)]).pressureTokens,undefined);
assert.equal(replay([...history,event('session/model-selected',{}),event('user/message',{}),usage(1,900)]).pressureTokens,undefined);
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
assert.ok(meterStart>=0&&meterEnd>meterStart);
const jsx=(type,props,key)=>({type,props,key});
const meter=vm.runInNewContext('('+bundle.slice(meterStart,meterEnd)+')',{
  contextOccupancy:fn,
  react:{useState:()=>[false,()=>{}],useRef:()=>({current:null}),useEffect:()=>{}},
  react_jsx_runtime:{jsx,jsxs:jsx},
  _xharness_dsh_client_ui_primitives:{Tooltip:'Tooltip'},
  ContextMeter_module_css_default:{root:'root',trigger:'trigger',track:'track',fill:'fill'},
  RADIUS:5.5,CIRCUMFERENCE:2*Math.PI*5.5,READING_SLOT:'\0',ROWS:[],
});
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
  const circle=button.props.children.props.children[1];
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
const failed=renderMeter({contextWindow:1000,phase:'unmeasured'});
assert.equal(failed.button.props.disabled,true);
const measured=renderMeter({contextWindow:1000,pressureTokens:500,pressureAccuracy:'provider_reported'});
assert.equal(measured.button.props['aria-label'],'上下文已用 50%');
const en=renderMeter({}, {'context.aria':'{percent} of context used',
  'context.pending':'Calculating context usage','context.unavailable':'Context usage unavailable'});
assert.equal(en.button.props['aria-label'],'Context usage unavailable');
assert.match(bundle,/"context.pending": "正在计算上下文"/);
assert.match(bundle,/"context.pending": "Calculating context usage"/);
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url)));
const entry=graph.entries.find(item=>item.id==='@xharness/dsh-client-ui-conversation');
assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));
const html=readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8');
assert.ok(html.includes(entry.url));
console.log('context meter: stable slot / no stale reading / unavailable / measured / bilingual / revision passed');
