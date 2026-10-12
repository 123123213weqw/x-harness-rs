import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { compileSourceModules } from './build-source-modules.mjs'
const id='@xlang/xharness-client-ui-performance'
const output=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id,source:'src/modules/performance/index.ts'},{id:id+'/test',source:'src/modules/performance/test-exports.ts'}])
function load(source){let registration;vm.runInNewContext(source,{window:{__ModuleLoader__:{load:r=>registration=r}}});return registration.factory(name=>{if(name==='react')return{};if(name==='react/jsx-runtime')return{};throw Error(name)})}
const api=load(output.get(id+'/test').bytes.toString()),plugin=load(output.get(id).bytes.toString())
const fixture=JSON.parse(readFileSync('protocol/fixtures/performance-timeline-v1.json','utf8'))
const plain=v=>JSON.parse(JSON.stringify(v))
test('real Rust reducer wire fixture is accepted without adapting its fields',()=>{
 assert.equal(api.readTimeline(fixture),fixture);assert.equal(api.sampleTps(fixture.turns[0].samples[1]),3);assert.equal(api.reportedTps(fixture.turns[0]),11/2.1)
})
test('missing data is unknown; malformed optional telemetry cannot invalidate chat history',()=>{
 for(const bad of [undefined,null,{}, {...fixture,schemaVersion:2},{...fixture,source:'measured'}, {...fixture,bucketMs:0}])assert.equal(api.readTimeline(bad),null)
 for(const path of [['turns',0,'samples',0,'textUnits'],['turns',0,'lastMs'],['turns',0,'requests',0,'endMs']]){
  const bad=structuredClone(fixture);let obj=bad;for(const key of path.slice(0,-1))obj=obj[key];obj[path.at(-1)]=-1;assert.equal(api.readTimeline(bad),null)
 }
 const noUsage=structuredClone(fixture.turns[0]);noUsage.requests[0].reportedOutputTokens=null;assert.equal(api.reportedTps(noUsage),null)
 const noSamples=structuredClone(fixture);noSamples.turns[0].samples=[];assert.equal(api.readTimeline(noSamples),noSamples)
})
test('curves split at missing seconds, new steps, retries; smoothing stays within those boundaries',()=>{
 const s=fixture.turns[0].samples[1];const turn={...fixture.turns[0],samples:[{...s,timeMs:1000,textUnits:4},{...s,timeMs:2000,textUnits:8},{...s,timeMs:6000,textUnits:40},{...s,timeMs:7000,attempt:1,textUnits:80},{...s,timeMs:8000,step:2,textUnits:100}]}
 assert.deepEqual(plain(api.series(turn,'textUnits',false)).map(s=>s.length),[2,1,1,1])
 assert.deepEqual(plain(api.series(turn,'textUnits',true)).map(s=>s.map(p=>p.textUnits)),[[4,6],[40],[80],[100]])
 assert.equal(api.nearest(turn,6500),turn.samples[2])
})
test('bounded payloads reject overflow and no inaccurate history-window recomputation',()=>{
 for(const field of ['samples','phases','requests']){const bad=structuredClone(fixture);const n={samples:601,phases:129,requests:65}[field];bad.turns[0][field]=Array.from({length:n},()=>bad.turns[0][field][0]);assert.equal(api.readTimeline(bad),null)}
 const source=output.get(id).bytes.toString();assert.doesNotMatch(source,/loadOlder|nodes\.map|assistant\/chunk|fetch\(/)
})
test('view belongs immediately after Harness; locale and CSS registrations are disposed',()=>{
 const slots=[],disposers=[],styles=[],dicts=[];const ctx={effect:fn=>{const d=fn();if(d)disposers.push(d)},locale:{register:(ns,data)=>{dicts.push(data);return()=>dicts.pop()},bind:()=>k=>k},slots:{inject:(name,fn)=>disposers.push(fn()),register:(spec,view)=>{slots.push({spec,view});return()=>slots.pop()}}}
 // Styles use the actual plugin effect, not a global lasting beyond unload.
 let registration;const globals={window:{__ModuleLoader__:{load:r=>registration=r}},document:{createElement:()=>({dataset:{},remove(){styles.pop()}}),head:{append:s=>styles.push(s)}}};vm.runInNewContext(output.get(id).bytes.toString(),globals);const p=registration.factory(name=>name==='react'?{}:{});p.apply(ctx)
 assert.equal(slots[0].spec.name,'conversation.view');assert.equal(slots[0].spec.id,'performance');assert.equal(slots[0].spec.order,31)
 assert.deepEqual(Object.keys(dicts[0].en).sort(),Object.keys(dicts[0].zh).sort());assert.match(dicts[0].zh.estimate,/估算/)
 disposers.reverse().forEach(d=>d());assert.equal(slots.length,0);assert.equal(dicts.length,0);assert.equal(styles.length,0)
})
test('production manifest uses owned TS and excludes private test exports',()=>{
 const manifest=JSON.parse(readFileSync('ui/modules.json','utf8'));assert.equal(manifest.modules.find(m=>m.id===id).source,'src/modules/performance/index.ts')
 assert.ok(!manifest.modules.some(m=>m.source?.includes('performance/test-exports')))
 assert.deepEqual(plain(plugin.inject),['slots','locale'])
})
