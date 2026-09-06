import assert from 'node:assert/strict';
import {test} from 'node:test';
import {goalCases,goalFixture,compileGoal,legacyGoal} from './goal-test-harness.mjs';
import {json} from './conversation-test-harness.mjs';
import {descendants} from './conversation-test-hooks.mjs';
const source=compileGoal().bytes.toString();
test('goal native/frozen public ABI and exact lifecycle stylesheet tags',()=>{const next=goalFixture(source),old=goalFixture(legacyGoal);assert.deepEqual(Object.keys(next.plugin).sort(),Object.keys(old.plugin).sort());assert.deepEqual(json(next.plugin.inject),json(old.plugin.inject));assert.deepEqual(json(next.styles),json(old.styles));});
for(const [label,impl] of [['source',source],['legacy',legacyGoal]])for(const[name,check]of Object.entries(goalCases))test(label+': '+name,()=>check(impl));
test('source: provider backoff is visible without replacing pause/resume controls',()=>{
  const f=goalFixture(source),projection=f.projection('network_backoff');
  const tree=f.render(projection);
  assert.match(JSON.stringify(tree),/网络异常，等待自动重试/);
  assert.match(JSON.stringify(f.render({...projection,execution:{...projection.execution,pauseDetail:'temporary provider outage'}})),/temporary provider outage/);
  assert.ok(tree);
});

test('source: model-completed Goal stays visible, needs no confirmation, and reopens only on a click',async()=>{
  const f=goalFixture(source),projection=f.projection('complete','complete');
  projection.execution.verificationMode='agent_report';
  const tree=f.render(projection),controls=f.controls(tree),body=f.invoke('controls',()=>controls.type(controls.props));
  assert.match(JSON.stringify(tree),/已完成/);
  const buttons=descendants(body,node=>node.type==='button');
  assert.equal(buttons.some(node=>node.props['aria-label']==='确认完成'),false);
  assert.equal(f.calls.length,0);
  await buttons.find(node=>node.props['aria-label']==='重新开启').props.onClick();
  await Promise.resolve();
  assert.deepEqual(json(f.calls),[{name:'onResume',args:[]}]);
});
