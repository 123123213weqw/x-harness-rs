import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {patchGoalRuntime} from './patch-goal-runtime.mjs';
import {assertRebuildInput} from './fixtures/repository-ui-input.mjs';
import {goalCases,legacyGoal} from './goal-test-harness.mjs';
const file=new URL('../ui/dist/plugins/@xharness/dsh-client-ui-goal/client.js',import.meta.url),bytes=readFileSync(file),text=bytes.toString();
// Patch machinery remains a frozen-bundle golden contract, not a transform over
// generated native TS. New behavior checks evaluate the whole actual factory.
const golden=Buffer.from(legacyGoal);assert.deepEqual(patchGoalRuntime(golden),golden);
assert.equal(legacyGoal.includes('XhGoalDetails'),false);assert.equal(legacyGoal.includes("jsx('details'"),false);assert.ok(legacyGoal.includes('jsx(XhGoalControls'));assert.ok(legacyGoal.includes('xh-goal-inline/v2'));assert.equal(legacyGoal.includes('XhGoalCreate'),false);assert.equal(legacyGoal.includes('设定目标'),false);
assert.throws(()=>patchGoalRuntime(Buffer.from('unknown upstream payload')),/anchor changed/);
assertRebuildInput('@xharness/dsh-client-ui-goal');new Script(text);
for(const[label,source]of[['actual artifact',text],['frozen golden',legacyGoal]])for(const[name,check]of Object.entries(goalCases)){await check(source);console.log(label+': '+name+' passed');}
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url))),plugin=graph.entries.find(e=>e.id==='@xharness/dsh-client-ui-goal'),html=readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8');assert.equal(plugin.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));assert.ok(html.includes(plugin.url));assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]),graph);
console.log('Goal: actual factory native behavior, frozen idempotent/fail-closed patch golden, source freshness/hash/preload/boot passed');
