// Evaluate the real public GoalBar/GoalDock ModuleLoader closure; hooks and Host
// services are the only doubles. No copied controls or source-text fragments.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness,json,tick} from './conversation-test-harness.mjs';
import {descendants} from './conversation-test-hooks.mjs';
import {compileSourceModules} from './build-source-modules.mjs';
export const goalId='@xharness/dsh-client-ui-goal';
export const legacyGoal=readFileSync(new URL(`../ui/reference/master-a613970/plugins/${goalId}/client.js`,import.meta.url),'utf8');
export function compileGoal(){return compileSourceModules(new URL('../ui/',import.meta.url).pathname,[{id:goalId,source:'src/modules/goal/index.ts'}]).get(goalId)}
export function goalFixture(source){
 const scopes=new Map();let active;
 const cell=initial=>{const index=active.cursor++;if(!(index in active.cells))active.cells[index]=typeof initial==='function'?initial():initial;return[active,index]};
 const react={useState:initial=>{const[scope,i]=cell(initial);return[scope.cells[i],next=>{scope.cells[i]=typeof next==='function'?next(scope.cells[i]):next}]},useRef:initial=>{const[scope,i]=cell(()=>({current:initial}));return scope.cells[i]},useEffect:(fn,deps)=>{const[scope,i]=cell(()=>({deps:undefined,off:undefined})),value=scope.cells[i];if(!value.deps||!deps||deps.length!==value.deps.length||deps.some((item,index)=>!Object.is(item,value.deps[index]))){scope.effects.push(()=>{value.off?.();value.deps=deps;value.off=fn()});}},useCallback:fn=>fn,memo:fn=>fn};
 const jsx={Fragment:'fragment',jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})};
 const loaded=harness(source,{react,jsx,globals:{Error}});
 const invoke=(name,fn)=>{active=scopes.get(name)??{cells:[],cursor:0,effects:[]};scopes.set(name,active);active.cursor=0;active.effects=[];const value=fn();for(const effect of active.effects)effect();return value};
 const calls=[];const handlers=Object.fromEntries(['onComplete','onBudget','onEdit','onPause','onResume','onClear'].map(name=>[name,async(...args)=>{calls.push({name,args});return{ok:true,value:{}}}]));
 const projection=(state='running',phase='active',id='g')=>({goal:{id,revision:2,objective:'Build and test',phase,maxGoalRounds:5},execution:{state,roundsStarted:3,maxGoalRounds:5}});
 const render=(value,overrides={})=>invoke('bar',()=>loaded.plugin.GoalBar({goal:value?.goal,projection:value,...handlers,...overrides,t:key=>key}));
 const controls=tree=>descendants(tree,node=>typeof node.type==='function'&&node.props?.runAction)[0];
 const renderControls=props=>invoke('controls',()=>controls(render(props.projection)).type(props));
 return{...loaded,invoke,calls,handlers,projection,render,controls,renderControls};
}
const buttons=tree=>descendants(tree,node=>node.type==='button');
const button=(tree,name)=>buttons(tree).find(node=>node.props['aria-label']===name);
export const goalCases={
 'silent absent, visible completion and single inline card':source=>{
  const f=goalFixture(source);assert.equal(f.render(undefined),null);assert.equal(f.render(null),null);
  const tree=f.render(f.projection('complete','complete'));assert.equal(descendants(tree,node=>'data-goal-bar' in (node.props??{})).length,1);assert.equal(descendants(tree,node=>node.type==='details').length,0);
  const control=f.controls(tree),body=f.invoke('controls',()=>control.type(control.props));assert.equal(descendants(body,node=>'data-goal-runtime' in (node.props??{})).length,1);assert.equal(button(body,'确认完成'),undefined);assert.equal(button(body,'预算'),undefined);
  for(const absent of [null,undefined]){const dock=f.plugin.GoalDock({useProjection:()=>absent,...f.handlers,t:key=>key});assert.equal(f.invoke('absent',()=>dock.type(dock.props)),null);}
 },
 'paused and blocked resume, running pause, disabled enable-only and wrapping':source=>{
  const f=goalFixture(source);for(const phase of ['paused','blocked']){const tree=f.render(f.projection(phase,phase));assert.ok(button(tree,'action.resume'));assert.equal(button(tree,'action.pause'),undefined);}
  assert.ok(button(f.render(f.projection()),'action.pause'));
  const disabled=f.render(f.projection('disabled'));assert.equal(button(disabled,'action.pause'),undefined);assert.deepEqual(json(disabled.props.children.props.style),{minHeight:36,height:'auto',flexWrap:'wrap'});
  const control=f.controls(disabled),body=f.invoke('controls',()=>control.type(control.props));assert.ok(button(body,'启用自动推进'));
 },
 'status and title preserve host states, reasons, reports and evidence':source=>{
  const f=goalFixture(source),projection=f.projection('blocked','blocked');projection.goal.blockedReason={message:'need secret'};projection.execution={...projection.execution,pauseReason:'round_budget',pauseDetail:'quota',report:{summary:'tests passed',remaining:['review output'],evidence:[{kind:'artifact',reference:'tests.txt'},{kind:'execution',execution_id:'exec-1'}]}};
  let tree=f.render(projection);assert.match(tree.props.children.props.title,/need secret/);assert.match(tree.props.children.props.title,/轮数预算已到/);assert.match(tree.props.children.props.title,/artifact: tests.txt/);assert.match(tree.props.children.props.title,/execution: exec-1/);
  assert.equal(tree.props.children.props.children[1].props.children,'需要帮助 · 3/5 轮');projection.execution.state='host-future-state';tree=f.render(projection);assert.equal(tree.props.children.props.children[1].props.children,'host-future-state · 3/5 轮');
 },
 'same-render dedupe, pending lock, rejected/network action and retry':async source=>{
  const f=goalFixture(source);let release,count=0;
  const projection=f.projection('paused','paused'),tree=f.render(projection,{onResume:async()=>{count++;return new Promise(resolve=>release=resolve)}});
  button(tree,'action.resume').props.onClick();button(tree,'action.resume').props.onClick();assert.equal(count,1);
  const pending=f.render(projection);assert.equal(button(pending,'action.resume').props.disabled,true);release({ok:false,error:{code:'offline',message:'failed'}});await tick();
  let retry=f.render(projection);assert.equal(button(retry,'action.resume').props.disabled,false);assert.match(descendants(retry,node=>node.props?.role==='alert')[0].props.children,/failed.*offline/);
  const run=f.controls(retry).props.runAction;assert.equal((await run(async()=>{throw Error('network')})).error.code,'network');assert.equal((await run(async()=>({ok:true,value:{}}))).ok,true);
 },
 'old pending receipt cannot paint or lock a replacement goal':async source=>{
  const f=goalFixture(source);let release;const first=f.render(f.projection());const run=f.controls(first).props.runAction;
  const pending=run(()=>new Promise(resolve=>release=resolve));f.render(f.projection('blocked','blocked','g2'));let next=f.render(f.projection('blocked','blocked','g2'));assert.equal(button(next,'action.resume').props.disabled,false);
  release({ok:false,error:{code:'old',message:'stale'}});assert.equal(await pending,undefined);next=f.render(f.projection('blocked','blocked','g2'));assert.equal(descendants(next,node=>node.props?.role==='alert').length,0);
 },
 'budget integer corners and pending one-shot dispatch stay inside the card':async source=>{
  const f=goalFixture(source),projection=f.projection(),tree=f.render(projection),control=f.controls(tree);const render=()=>f.invoke('controls',()=>control.type(control.props));let body=render();button(body,'预算').props.onClick();
  for(const invalid of ['0','-1','1.5','9007199254740992','']){body=render();descendants(body,node=>node.type==='input')[0].props.onChange({target:{value:invalid}});body=render();assert.equal(button(body,'保存轮数预算').props.disabled,true);await descendants(body,node=>node.type==='form')[0].props.onSubmit({preventDefault(){}});}
  assert.equal(f.calls.length,0);body=render();descendants(body,node=>node.type==='input')[0].props.onChange({target:{value:'12'}});body=render();assert.equal(button(body,'保存轮数预算').props.disabled,false);await descendants(body,node=>node.type==='form')[0].props.onSubmit({preventDefault(){}});assert.deepEqual(json(f.calls),[{name:'onBudget',args:[12]}]);assert.ok(button(render(),'预算'));
 },
 'injected mutations read current projection CAS, and absent goals never mutate':async source=>{
  const f=goalFixture(source),registrations=[],calls=[];let projection=f.projection();const verbs=Object.fromEntries(['edit','pause','resume','clear','complete'].map(name=>[name,async(...args)=>{calls.push({name,args});return{ok:true,value:{}}}]));
  f.plugin.apply({conversationEvents:{register(){}},effect:fn=>fn(),locale:{register(){},bind:()=>key=>key},sessions:{binding:()=>({session:{projections:{faceOf:()=>({getSnapshot:()=>projection})}}})},remote:{goals:verbs},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>registrations.push({spec,component})}});
  const inject=registrations.find(row=>row.spec.name==='conversation.input.dock').spec.inject,actions=inject('session');projection={...projection,goal:{...projection.goal,id:'latest',revision:9}};await actions.onResume();await actions.onBudget(12);assert.deepEqual(json(calls),[{name:'resume',args:['session',{id:'latest',revision:9}]},{name:'edit',args:['session',{id:'latest',revision:9},{maxGoalRounds:12}]}]);projection=null;assert.equal((await actions.onComplete()).error.code,'no-current-goal');assert.equal(calls.length,2);assert.equal('onCreate' in actions,false);
 },
};
