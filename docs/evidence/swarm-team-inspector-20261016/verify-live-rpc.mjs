import {readFileSync,writeFileSync} from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
const state=JSON.parse(readFileSync('/tmp/swarm-scale12-live.json','utf8'))
const {compileSourceModules}=await import(process.cwd()+'/scripts/build-source-modules.mjs')
const output=compileSourceModules(process.cwd()+'/ui',[{id:'swarm-live-inspector',source:'src/modules/swarm/client.ts'}]).get('swarm-live-inspector')
let registration
vm.runInNewContext(output.bytes.toString(),{window:{__ModuleLoader__:{load:row=>registration=row}}})
const {SwarmClient}=registration.factory()
async function rpc(method,payload){
 const response=await fetch('http://127.0.0.1:3293/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload})})
 const body=await response.json();if(!body.result.ok)throw Error(body.result.error.message);return body.result.value
}
const client=new SwarmClient({call:async(_channel,method,payload)=>({ok:true,value:await rpc(method,payload)})})
const before=await rpc('session.list',{})
const inspection=await client.inspect(state.owner,state.team,new AbortController().signal)
assert.equal(Object.keys(inspection.swarm.members).length,12)
assert.equal(inspection.progress.accepted,13)
const detail=await client.workerDetail({parentSessionId:state.owner,childSessionId:state.workers['Range 01'],mode:'continuable'},new AbortController().signal)
assert.equal(detail.model.provider,'deepseek');assert.equal(detail.model.model,'deepseek-flash')
assert.match(detail.answer.text,/CHECKSUM=7260/)
assert.equal(detail.activity.text,'Turn completed')
const after=await rpc('session.list',{})
const ids=new Set([state.owner,...Object.values(state.workers)])
const usage=rows=>rows.items.filter(row=>ids.has(row.sessionId)).map(row=>[row.sessionId,row.projections?.values?.tokenUsage,row.projections?.values?.sessionStats?.steps,row.projections?.values?.sessionStats?.turns]).sort((a,b)=>a[0].localeCompare(b[0]))
assert.deepEqual(usage(after),usage(before))
const record={passed:true,source:'Actual source client compiled by the repository builder against existing V100 Host; backend RPC read validation, not a screenshot',workers:12,progress:inspection.progress,lastUsedModel:detail.model,latestRecordedActivity:detail.activity,publicAnswer:detail.answer,taskResult:inspection.work[state.workers['Range 01']].result,noAdditionalModelUsageOrTurns:true}
writeFileSync('docs/evidence/swarm-team-inspector-20261016/live-rpc.json',JSON.stringify(record,null,2)+'\n')
console.log(JSON.stringify(record))
