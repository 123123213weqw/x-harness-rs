import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {goalCases,goalFixture,compileGoal,legacyGoal,compactGoalCases} from './goal-test-harness.mjs';
import {json,tick} from './conversation-test-harness.mjs';
import {descendants} from './conversation-test-hooks.mjs';
const source=compileGoal().bytes.toString();
test('goal preserves existing ABI/styles and adds the independent Progress surface',()=>{const next=goalFixture(source),old=goalFixture(legacyGoal);assert.deepEqual(Object.keys(next.plugin).filter(key=>key!=='ProgressDock').sort(),Object.keys(old.plugin).sort());assert.deepEqual(json(next.plugin.inject),json(old.plugin.inject));const reviewed=readFileSync(new URL('../ui/src/modules/goal/GoalBar.css',import.meta.url),'utf8');
 assert.equal(createHash('sha256').update(reviewed).digest('hex'),'3c973502aa5ccd4d29bb43c80c201eecd9fadd0fcbb2a6f09e541dfdf433e47e','reviewed two-line preview and full-size Goal details/editor styling');
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

const modalOf=tree=>descendants(tree,node=>node.type==='Modal'&&['details.title','edit.title'].includes(node.props?.title))[0];
const nativeButton=(tree,name)=>descendants(tree,node=>node.type==='button'&&node.props?.['aria-label']?.startsWith(name))[0];
const surfaceButton=(tree,name)=>descendants(tree,node=>node.props?.children===name&&typeof node.props?.onClick==='function')[0];
const textareaOf=tree=>descendants(tree,node=>node.type==='textarea')[0];
test('long Goal details expose complete selectable text and do not submit by viewing',()=>{
 const f=goalFixture(source),p=f.projection();p.goal.objective=('完整目标\n'+'x'.repeat(300)+'\n').repeat(50);
 let tree=f.render(p);nativeButton(tree,'action.view').props.onClick();tree=f.render(p);
 const modal=modalOf(tree);assert.equal(modal.props.open,true);assert.equal(modal.props.title,'details.title');
 const full=descendants(modal.props.children,node=>node.props?.['data-goal-description'])[0];
 assert.equal(full.props.children,p.goal.objective);assert.equal(full.props.tabIndex,0);assert.equal(f.calls.length,0);
 surfaceButton(modal.props.footer,'action.edit').props.onClick();tree=f.render(p);
 assert.equal(modalOf(tree).props.title,'edit.title');assert.equal(textareaOf(tree).props.value,p.goal.objective);
 assert.equal(textareaOf(tree).props.rows,12);assert.equal(textareaOf(tree).props.maxLength,undefined);
});
test('multiline Goal editing preserves newline, uses explicit save shortcut, and retains rejected drafts',async()=>{
 const f=goalFixture(source),p=f.projection();let tree=f.render(p);f.controls(tree).props.beginEdit();tree=f.render(p);
 textareaOf(tree).props.onChange({target:{value:'  first line\nsecond line  '}});tree=f.render(p);
 let prevented=false;textareaOf(tree).props.onKeyDown({key:'Enter',metaKey:false,ctrlKey:false,nativeEvent:{isComposing:false},preventDefault(){prevented=true}});
 assert.equal(prevented,false);assert.equal(f.calls.length,0,'plain Enter must not save');
 textareaOf(tree).props.onKeyDown({key:'Enter',metaKey:true,ctrlKey:false,nativeEvent:{isComposing:true},preventDefault(){throw Error('IME should not save')}});
 assert.equal(f.calls.length,0);
 tree=f.render(p,{onEdit:async()=>({ok:false,error:{code:'offline',message:'not saved'}})});
 surfaceButton(modalOf(tree).props.footer,'action.save').props.onClick();await tick();tree=f.render(p);
 assert.equal(modalOf(tree).props.open,true);assert.equal(textareaOf(tree).props.value,'  first line\nsecond line  ');assert.match(JSON.stringify(tree),/not saved/);
 textareaOf(tree).props.onKeyDown({key:'Enter',metaKey:false,ctrlKey:true,nativeEvent:{isComposing:false},preventDefault(){prevented=true}});await tick();
 assert.deepEqual(json(f.calls),[{name:'onEdit',args:['first line\nsecond line',{id:p.goal.id,objective:p.goal.objective}]}]);
 assert.equal(modalOf(f.render(p)).props.open,false);
});
test('external description edits preserve the draft and block overwriting until explicit reload',async()=>{
 const f=goalFixture(source),p=f.projection();let tree=f.render(p);f.controls(tree).props.beginEdit();tree=f.render(p);
 textareaOf(tree).props.onChange({target:{value:'my unsaved text'}});
 const changed={...p,goal:{...p.goal,revision:p.goal.revision+1,objective:'new authoritative description'}};
 tree=f.render(changed);assert.equal(textareaOf(tree).props.value,'my unsaved text');
 assert.equal(surfaceButton(modalOf(tree).props.footer,'action.save').props.disabled,true);
 textareaOf(tree).props.onKeyDown({key:'Enter',metaKey:true,ctrlKey:false,nativeEvent:{isComposing:false},preventDefault(){}});await tick();
 assert.equal(f.calls.length,0);assert.match(JSON.stringify(f.render(changed)),/edit.conflict/);
 surfaceButton(modalOf(tree).props.children,'edit.reload').props.onClick();tree=f.render(changed);
 assert.equal(textareaOf(tree).props.value,'new authoritative description');
 assert.equal(surfaceButton(modalOf(tree).props.footer,'action.save').props.disabled,false);
 const replacement={...changed,goal:{...changed.goal,id:'replacement'}};
 assert.equal(modalOf(f.render(replacement)).props.open,false,'switching goal identity closes the old editor before any effect runs');
});
test('Goal edit injection fences viewed identity/text while tolerating round-stat revisions',async()=>{
 const f=goalFixture(source),registrations=[],calls=[];let projection=f.projection();
 const verbs=Object.fromEntries(['edit','pause','resume','clear','complete'].map(name=>[name,async(...args)=>{calls.push({name,args});return{ok:true,value:{}}}]));
 f.plugin.apply({conversationEvents:{register(){}},effect:fn=>fn(),locale:{register(){},bind:()=>key=>key},sessions:{binding:()=>({session:{projections:{faceOf:()=>({getSnapshot:()=>projection})}}})},remote:{goals:verbs},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>registrations.push({spec,component})}});
 const actions=registrations.find(row=>row.spec.id==='goal').spec.inject('s'),expected={id:projection.goal.id,objective:projection.goal.objective};
 projection={...projection,goal:{...projection.goal,revision:99}};
 assert.equal((await actions.onEdit('multiline\nvalue',expected)).ok,true);assert.equal(calls[0].args[1].revision,99);
 projection={...projection,goal:{...projection.goal,objective:'changed'}};
 assert.equal((await actions.onEdit('do not overwrite',expected)).error.code,'goal-changed');
 projection={...projection,goal:{...projection.goal,id:'different',objective:expected.objective}};
 assert.equal((await actions.onEdit('do not edit replacement',expected)).error.code,'goal-changed');assert.equal(calls.length,1);
});
