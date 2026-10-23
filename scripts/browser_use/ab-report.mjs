#!/usr/bin/env node
// Audit paired measurements from persisted facts; never rescore a model's answer.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { AB_TASKS } from './ab-fixture.mjs';
const root=resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Usage: node ab-report.mjs <completed-result-directory> [output-json]');
const summary=JSON.parse(await readFile(join(root,'summary.json'),'utf8'));
assert.equal(summary.complete,true,'Partial runs cannot become a complete A/B report');
const rows=[],keys=new Set(),images=new Map();
for(let repeat=0;repeat<summary.repeats;repeat++)for(const task of AB_TASKS)for(const arm of ['candidate','reference']){
 const path=join(root,`${task.id}-${repeat}-${arm}.json`),bytes=await readFile(path),row=JSON.parse(bytes);
 assert.equal(row.taskId,task.id);assert.equal(row.repeat,repeat);assert.equal(row.arm,arm);
 const key=`${task.id}/${repeat}/${arm}`;assert.ok(!keys.has(key));keys.add(key);
 assert.equal(typeof row.score.success,'boolean');assert.equal(row.score.passed,row.score.success);
 assert.equal(row.fixture.score.success,row.score.passed,'Page-owned score mismatch');
 assert.equal(row.score.passed,Object.values(row.score.criteria).every(value=>value===true),'All criteria must be met');
 assert.ok(!bytes.includes(Buffer.from('"reasoning_content"')),'Provider reasoning must not be persisted');
 assert.ok(!bytes.includes(Buffer.from('iVBORw0KGgo')),'Inline PNG data must not become transcript evidence');
 if(row.score.passed)assert.ok(row.fixture.events.some(event=>event.kind==='action'&&event.accepted&&event.action?.trusted===true),'Pass needs native UI state evidence');
 for(const item of row.trace)for(const image of item.images){
  const data=await readFile(join(root,'media',image.sha256+'.png'));
  assert.equal(createHash('sha256').update(data).digest('hex'),image.sha256);
  assert.equal(data.length,image.bytes);assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');images.set(image.sha256,image.bytes);
 }
 row.evidenceSha256=createHash('sha256').update(bytes).digest('hex');rows.push(row);
}
assert.equal(summary.trials.length,rows.length,'Summary may not hide or add trials');
const median=values=>{const v=[...values].sort((a,b)=>a-b),i=Math.floor(v.length/2);return v.length?(v.length%2?v[i]:(v[i-1]+v[i])/2):null;};
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const arms={};
for(const arm of ['candidate','reference']){
 const r=rows.filter(row=>row.arm===arm),usage={};
 for(const row of r)for(const req of row.requests)for(const[k,v]of Object.entries(req.usage??{}))if(typeof v==='number')usage[k]=(usage[k]??0)+v;
 arms[arm]={trials:r.length,passed:r.filter(row=>row.score.passed).length,failed:r.filter(row=>!row.score.passed).length,successRate:r.filter(row=>row.score.passed).length/r.length,meanElapsedMs:Math.round(mean(r.map(row=>row.elapsedMs))),medianElapsedMs:median(r.map(row=>row.elapsedMs)),modelLatencyMs:r.reduce((a,row)=>a+row.requests.reduce((n,req)=>n+req.elapsedMs,0),0),toolLatencyMs:r.reduce((a,row)=>a+row.trace.reduce((n,item)=>n+item.elapsedMs,0),0),toolCalls:r.reduce((a,row)=>a+row.trace.length,0),providerAttempts:r.reduce((a,row)=>a+row.requests.length,0),providerErrors:r.reduce((a,row)=>a+row.requests.filter(req=>req.error).length,0),imageCalls:r.reduce((a,row)=>a+row.trace.filter(item=>item.images.length).length,0),toolTextBytes:r.reduce((a,row)=>a+row.trace.reduce((n,item)=>n+item.textBytes,0),0),usage};
 assert.equal(arms[arm].passed,summary.aggregate[arm].passed,'Summary success count mismatch');
}
const pairs=[],byTask=[];
for(const task of AB_TASKS){
 const t={taskId:task.id,label:task.label,candidatePassed:0,referencePassed:0,repetitions:summary.repeats};
 for(let repeat=0;repeat<summary.repeats;repeat++){
  const a=rows.find(row=>row.taskId===task.id&&row.repeat===repeat&&row.arm==='candidate'),b=rows.find(row=>row.taskId===task.id&&row.repeat===repeat&&row.arm==='reference');
  assert.equal(a.seed,b.seed);assert.equal(a.scenarioHash,b.scenarioHash,'Each pair must use identical generated task facts');
  t.candidatePassed+=Number(a.score.passed);t.referencePassed+=Number(b.score.passed);
  pairs.push({taskId:task.id,repeat,scenarioHash:a.scenarioHash,candidatePassed:a.score.passed,referencePassed:b.score.passed,candidateMs:a.elapsedMs,referenceMs:b.elapsedMs,candidateEvidenceSha256:a.evidenceSha256,referenceEvidenceSha256:b.evidenceSha256});
 }
 byTask.push(t);
}
const settled=rows.every(row=>row.terminalSettlement?.maximumMs===500&&row.terminalSettlement.successObservedBeforeClose===row.score.passed);
const report={schema:'xharness.browser-use.audited-model-ab.v1',generatedAt:new Date().toISOString(),source:root,summarySha256:createHash('sha256').update(await readFile(join(root,'summary.json'))).digest('hex'),config:summary.config,experimentCompleted:true,terminalSettlementValidated:settled,usableAsPrimaryComparison:settled,warning:settled?'Observed on this small generated task suite, not universal superiority or full ZCode agent parity':'Historical phase used immediate cleanup: preserve raw facts, but terminal-effect teardown may create false negatives. Do not use it as the corrected primary comparison.',arms,byTask,paired:{total:pairs.length,candidateOnly:pairs.filter(p=>p.candidatePassed&&!p.referencePassed).length,referenceOnly:pairs.filter(p=>!p.candidatePassed&&p.referencePassed).length,bothPassed:pairs.filter(p=>p.candidatePassed&&p.referencePassed).length,bothFailed:pairs.filter(p=>!p.candidatePassed&&!p.referencePassed).length,medianCandidateMinusReferenceMs:median(pairs.map(p=>p.candidateMs-p.referenceMs))},pairs,failed:rows.filter(row=>!row.score.passed).map(row=>({taskId:row.taskId,repeat:row.repeat,arm:row.arm,stopReason:row.stopReason,failedCriteria:row.score.failedCriteria,error:row.error??null,actions:row.trace.length,providerAttempts:row.requests.length,evidenceSha256:row.evidenceSha256,attribution:'Requires trace review; no automatic model-vs-tool conclusion'})),media:{distinctPngs:images.size,totalBytes:[...images.values()].reduce((a,b)=>a+b,0)},provenance:summary.provenance,boundaries:summary.limitations};
if(process.argv[3])await writeFile(resolve(process.argv[3]),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
