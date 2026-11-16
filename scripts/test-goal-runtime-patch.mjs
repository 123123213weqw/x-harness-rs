import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {assertRebuildInput} from './fixtures/repository-ui-input.mjs';
import {goalCases,legacyGoal,compactGoalCases} from './goal-test-harness.mjs';
const file=new URL('../ui/dist/plugins/@xharness/dsh-client-ui-goal/client.js',import.meta.url),bytes=readFileSync(file),text=bytes.toString();
// Exercise actual and independent frozen factories, not old injection machinery.
assert.equal(legacyGoal.includes('XhGoalDetails'),false);assert.equal(legacyGoal.includes("jsx('details'"),false);assert.ok(legacyGoal.includes('jsx(XhGoalControls'));assert.ok(legacyGoal.includes('xh-goal-inline/v2'));assert.equal(legacyGoal.includes('XhGoalCreate'),false);assert.equal(legacyGoal.includes('设定目标'),false);
assertRebuildInput('@xharness/dsh-client-ui-goal');new Script(text);
for(const[label,source,cases]of[['actual artifact',text,compactGoalCases],['frozen golden',legacyGoal,goalCases]])for(const[name,check]of Object.entries(cases)){await check(source);console.log(label+': '+name+' passed');}
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url))),plugin=graph.entries.find(e=>e.id==='@xharness/dsh-client-ui-goal'),html=readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8');assert.equal(plugin.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));assert.ok(html.includes(plugin.url));assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]),graph);
console.log('Goal: actual factory native behavior, frozen behavior golden, source freshness/hash/preload/boot passed');
