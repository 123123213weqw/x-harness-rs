import assert from 'node:assert/strict';
import {test} from 'node:test';
import {goalCases,goalFixture,compileGoal,legacyGoal} from './goal-test-harness.mjs';
import {json} from './conversation-test-harness.mjs';
const source=compileGoal().bytes.toString();
test('goal native/frozen public ABI and exact lifecycle stylesheet tags',()=>{const next=goalFixture(source),old=goalFixture(legacyGoal);assert.deepEqual(Object.keys(next.plugin).sort(),Object.keys(old.plugin).sort());assert.deepEqual(json(next.plugin.inject),json(old.plugin.inject));assert.deepEqual(json(next.styles),json(old.styles));});
for(const [label,impl] of [['source',source],['legacy',legacyGoal]])for(const[name,check]of Object.entries(goalCases))test(label+': '+name,()=>check(impl));
