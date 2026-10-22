import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {goalCases,goalFixture,compileGoal,legacyGoal,compactGoalCases} from './goal-test-harness.mjs';
import {json} from './conversation-test-harness.mjs';
import {descendants} from './conversation-test-hooks.mjs';
const source=compileGoal().bytes.toString();
test('goal preserves existing ABI/styles and adds the independent Progress surface',()=>{const next=goalFixture(source),old=goalFixture(legacyGoal);assert.deepEqual(Object.keys(next.plugin).filter(key=>key!=='ProgressDock').sort(),Object.keys(old.plugin).sort());assert.deepEqual(json(next.plugin.inject),json(old.plugin.inject));const reviewed=readFileSync(new URL('../ui/src/modules/goal/GoalBar.css',import.meta.url),'utf8');
 assert.equal(createHash('sha256').update(reviewed).digest('hex'),'ca5a2ea3e9c8ca14000710bd98138585b414aefa010b3053f81d1231749bc2a2','reviewed compact Goal styling');
 const expected=old.styles.map(style=>style.dataset.pluginCss.endsWith('/GoalBar.module.css')?{...style,textContent:reviewed}:style);
 assert.deepEqual(json(next.styles.filter(style=>!style.dataset.pluginCss.endsWith('/ProgressDock.css'))),json(expected));});
for(const [label,impl,cases] of [['source',source,compactGoalCases],['legacy',legacyGoal,goalCases]])for(const[name,check]of Object.entries(cases))test(label+': '+name,()=>check(impl));
test('source: provider backoff is visible without replacing pause/resume controls',()=>{
  const f=goalFixture(source),projection=f.projection('network_backoff');
  const tree=f.render(projection);
  const controls=f.controls(tree);assert.match(JSON.stringify(f.invoke('controls',()=>controls.type(controls.props))),/state.networkBackoff/);
  assert.match(JSON.stringify(f.render({...projection,execution:{...projection.execution,pauseDetail:'temporary provider outage'}})),/temporary provider outage/);
  assert.ok(tree);
});

test('source: model-completed Goal stays visible, needs no confirmation, and reopens only on a click',async()=>{
  const f=goalFixture(source),projection=f.projection('complete','complete');
  projection.execution.verificationMode='agent_report';
  const tree=f.render(projection),controls=f.controls(tree),body=f.invoke('controls',()=>controls.type(controls.props));
  assert.match(JSON.stringify(body),/phase.complete/);
  const buttons=descendants(body,node=>node.type==='button');
  assert.equal(buttons.some(node=>node.props['aria-label']==='action.confirm'),false);
  assert.equal(f.calls.length,0);
  await buttons.find(node=>node.props['aria-label']==='action.reopen').props.onClick();
  await Promise.resolve();
  assert.deepEqual(json(f.calls),[{name:'onResume',args:[]}]);
});

const plan = {revision: 3, items: [
 {id:'done',title:'Implement',status:'completed'},
 {id:'run',title:'Test',status:'in_progress'},
 {id:'next',title:'Submit PR',status:'pending'},
]};
test('Progress is absent for old/cleared plans and reads only taskPlan',()=>{
 const f=goalFixture(source);
 for(const absent of [undefined,null,{revision:4,items:[]}]) {
  assert.equal(f.plugin.ProgressDock({useProjection:name=>{assert.equal(name,'taskPlan');return absent},t:key=>key}),null);
 }
});
test('Progress preserves authoritative order, completion counts and literal user titles',()=>{
 const f=goalFixture(source);
 const value={...plan,items:[...plan.items,{id:'parallel',title:'<script>not HTML</script>',status:'in_progress'}]};
 const tree=f.plugin.ProgressDock({useProjection:()=>value,t:key=>key});
 assert.equal(tree.props['data-task-plan-revision'],3);
 assert.equal(descendants(tree,node=>node.props?.className==='xh-progress-count')[0].props.children.join(''),'1/4');
 const items=descendants(tree,node=>node.props?.['data-plan-item']);
 assert.deepEqual(items.map(item=>item.props['data-plan-item']),['done','run','next','parallel']);
 assert.deepEqual(items.map(item=>item.props['data-plan-status']),['completed','in_progress','pending','in_progress']);
 assert.equal(descendants(tree,node=>node.type==='script').length,0);
 assert.equal(descendants(tree,node=>node.type==='button').length,0,'plan display must not mutate execution');
});

test('Progress rejects malformed generic projections instead of guessing fields',()=>{
 const f=goalFixture(source);
 for (const invalid of [42,{}, {revision:0,items:[]},{revision:1,items:'bad'},
  {revision:1,items:[{id:'a',title:'bad',status:'blocked'}]},
  {revision:1,items:[{id:'a',title:'one',status:'pending'},{id:'a',title:'two',status:'pending'}]},
 ]) assert.equal(f.plugin.ProgressDock({useProjection:()=>invalid,t:key=>key}),null);
});
