/** Protocol decoding and routing tests; no Host, credentials or model requests. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
const id='swarm-client-test'
const output=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id,source:'src/modules/swarm/client.ts'}]).get(id)
let registration
vm.runInNewContext(output.bytes.toString(),{window:{__ModuleLoader__:{load:row=>registration=row}}})
const {parseTeam,parseInspection,SwarmClient}=registration.factory()
const plain=value=>JSON.parse(JSON.stringify(value))
const team=()=>({id:'s1',ownerSessionId:'owner',workspace:'/work',objective:'Fix startup',revision:1,autoDispatch:false,status:'active',members:{child:{sessionId:'child',assignment:'Regression tests'}}})
const observation=()=>({sessionId:'child',activity:'idle',sessionRevision:0,lastTurnEnd:{kind:'completed'},unresolvedToolCalls:[],pendingMessages:0})
test('strict Swarm snapshots accept real schema and reject malformed identities/counts',()=>{
 assert.deepEqual(plain(parseTeam(team())),team())
 for(const bad of [null,[],{...team(),revision:0},{...team(),revision:1.5},{...team(),revision:Infinity},{...team(),status:'running'},{...team(),workspace:''},{...team(),members:{child:{sessionId:'other',assignment:'x'}}},JSON.parse('{"id":"s1","ownerSessionId":"owner","workspace":"/work","objective":"x","revision":1,"status":"active","members":{"__proto__":{"sessionId":"__proto__","assignment":"x"}}}')])assert.throws(()=>parseTeam(bad))
})
test('worker observations require exact membership, activity and safe nonnegative counters',()=>{
 const valid={swarm:team(),workers:[observation()]};assert.deepEqual(plain(parseInspection(valid)),{...valid,work:{},progress:{total:0,pending:0,assigned:0,accepted:0,failed:0}})
 for(const workers of [[],[observation(),observation()],[{...observation(),sessionId:'other'}],[{...observation(),activity:'accepted'}],[{...observation(),pendingMessages:-1}],[{...observation(),sessionRevision:1.5}],[{...observation(),unresolvedToolCalls:[42]}],[{...observation(),lastTurnEnd:{kind:''}}]])assert.throws(()=>parseInspection({...valid,workers}))
})
test('RPC uses existing endpoint, explicit owner and CAS; never submits or probes a model',async()=>{
 const calls=[],signal=new AbortController().signal
 const client=new SwarmClient({call:async(...args)=>{calls.push(args);const action=args[2].command.action;return {ok:true,value:action==='list'?{swarms:[team()]}:action==='inspect'?{swarm:team(),workers:[observation()]}:{swarmId:'s1',revision:2}}}})
 await client.list('owner',signal);await client.inspect('owner','s1',signal);assert.equal(await client.create('owner','Fix startup'),'s1');await client.status(team(),'paused');await client.attach(team(),'child')
 assert.deepEqual(plain(calls.map(c=>c.slice(0,3))),[
 ['/api','swarm/manage',{ownerSessionId:'owner',command:{action:'list'}}],
 ['/api','swarm/manage',{ownerSessionId:'owner',command:{action:'inspect',swarmId:'s1'}}],
 ['/api','swarm/manage',{ownerSessionId:'owner',command:{action:'create',objective:'Fix startup'}}],
 ['/api','swarm/manage',{ownerSessionId:'owner',command:{action:'set_status',swarmId:'s1',expectedRevision:1,status:'paused'}}],
 ['/api','swarm/manage',{ownerSessionId:'owner',command:{action:'attach_member',swarmId:'s1',expectedRevision:1,childSessionId:'child'}}]])
 assert.equal(calls[0][3],signal);assert.equal(calls[1][3],signal)
})
test('rejects crossed owner/target and RPC errors without automatic retry',async()=>{
 let calls=0,response={swarms:[{...team(),ownerSessionId:'other'}]}
 const client=new SwarmClient({call:async()=>{calls++;return {ok:true,value:response}}})
 await assert.rejects(()=>client.list('owner',new AbortController().signal),/owner/)
 response={swarm:team(),workers:[observation()]};await assert.rejects(()=>client.inspect('owner','wrong',new AbortController().signal),/target/)
 const broken=new SwarmClient({call:async()=>{calls++;return {ok:false,error:{message:'revision conflict'}}}})
 await assert.rejects(()=>broken.status(team(),'paused'),/revision conflict/);assert.equal(calls,3)
})
const {parseTaskPage}=registration.factory()
const task=()=>({id:'task-1',title:'Regression',instructions:'Check recovery',dependencies:[],eligibleWorkerSessionIds:[],state:{status:'pending'}})
const page=()=>({swarmId:'s1',revision:4,tasks:[{task:task(),ready:true}],hasMore:false,nextCursor:null})
test('task page decodes pending, assigned and accepted results with strict pagination',()=>{
 assert.deepEqual(plain(parseTaskPage(page())),page())
 for(const state of [{status:'assigned',workerSessionId:'child',messageId:'m1',delivered:false},{status:'settled',workerSessionId:'child',messageId:'m1',turn:3,outcome:'completed',summary:'Tests passed'},{status:'settled',workerSessionId:'child',messageId:'m1',turn:null,outcome:'failed',summary:'Provider unavailable'}]){
  const valid={...page(),tasks:[{task:{...task(),state},ready:false}]};assert.deepEqual(plain(parseTaskPage(valid)),valid)
 }
 for(const bad of [null,{...page(),revision:0},{...page(),hasMore:true},{...page(),nextCursor:'task-1'},{...page(),tasks:[...page().tasks,...page().tasks]},{...page(),tasks:[{task:{...task(),dependencies:['task-1']},ready:true}]},{...page(),tasks:[{task:{...task(),state:{status:'assigned',workerSessionId:'child',messageId:'m1',delivered:'yes'}},ready:false}]},{...page(),tasks:[{task:{...task(),state:{status:'settled',workerSessionId:'child',messageId:'m1',turn:null,outcome:'completed',summary:'x'}},ready:false}]},{...page(),tasks:[{task:{...task(),state:{status:'assigned',workerSessionId:'child',messageId:'m1',delivered:true}},ready:true}]}])assert.throws(()=>parseTaskPage(bad))
})
test('task actions use the task endpoint, explicit revision and no automatic retry',async()=>{
 const calls=[],signal=new AbortController().signal
 let response=page()
 const client=new SwarmClient({call:async(...args)=>{calls.push(args);return {ok:true,value:response}}})
 await client.tasks(team(),false,null,signal)
 await client.addTask(team(),4,'Regression','Check recovery',['older'])
 await client.claimTask(team(),5,'task-1','child')
 assert.deepEqual(plain(calls.map(c=>c.slice(0,3))),[
  ['/api','swarm/tasks',{ownerSessionId:'owner',command:{action:'list',swarmId:'s1',includeSettled:false,limit:50}}],
  ['/api','swarm/tasks',{ownerSessionId:'owner',command:{action:'add',swarmId:'s1',expectedRevision:4,title:'Regression',instructions:'Check recovery',dependencies:['older'],eligibleWorkerSessionIds:[]}}],
  ['/api','swarm/tasks',{ownerSessionId:'owner',command:{action:'claim',swarmId:'s1',expectedRevision:5,taskId:'task-1',workerSessionId:'child'}}]])
 assert.equal(calls[0][3],signal)
 response={...page(),swarmId:'wrong'};await assert.rejects(()=>client.tasks(team(),false,null,signal),/target/)
 response=page();await assert.rejects(()=>client.tasks(team(),false,'task-2',signal),/cursor/)
 let attempts=0;const broken=new SwarmClient({call:async()=>{attempts++;throw Error('response lost')}})
 await assert.rejects(()=>broken.claimTask(team(),4,'task-1','child'),/response lost/);assert.equal(attempts,1)
})

test('automatic dispatch is backward-compatible, strictly typed and explicitly configured',async()=>{
 const old=team();delete old.autoDispatch;assert.equal(parseTeam(old).autoDispatch,false)
 assert.throws(()=>parseTeam({...team(),autoDispatch:'yes'}))
 const oldTask=task();delete oldTask.eligibleWorkerSessionIds
 assert.deepEqual(plain(parseTaskPage({...page(),tasks:[{task:oldTask,ready:true}]}).tasks[0].task.eligibleWorkerSessionIds),[])
 for(const workers of [['child','child'],[42],Array(65).fill('child')])assert.throws(()=>parseTaskPage({...page(),tasks:[{task:{...task(),eligibleWorkerSessionIds:workers},ready:true}]}))
 const calls=[]
 const client=new SwarmClient({call:async(...args)=>{calls.push(args);return {ok:true,value:{swarmId:'s1',revision:5}}}})
 await client.dispatch(team(),4,true)
 await client.addTask(team(),5,'Inspect','Read evidence',[],['child'])
 assert.deepEqual(plain(calls.map(c=>c.slice(0,3))),[
  ['/api','swarm/manage',{ownerSessionId:'owner',command:{action:'set_dispatch',swarmId:'s1',expectedRevision:4,enabled:true}}],
  ['/api','swarm/tasks',{ownerSessionId:'owner',command:{action:'add',swarmId:'s1',expectedRevision:5,title:'Inspect',instructions:'Read evidence',dependencies:[],eligibleWorkerSessionIds:['child']}}]])
})

test('live worker facts retain counts and one bounded result, not task instructions',()=>{
 const assigned={id:'assigned',title:'Inspect startup',instructions:'Do not retain this body',state:{status:'assigned',workerSessionId:'child',messageId:'m',delivered:true}}
 const accepted={id:'accepted',title:'Baseline',state:{status:'settled',workerSessionId:'child',messageId:'m0',turn:1,outcome:'completed',summary:'A long result is not copied'}}
 const value={swarm:{...team(),tasks:{assigned,accepted}},workers:[observation()]}
 const inspection=parseInspection(value)
 assert.deepEqual(plain(inspection.work),{child:{assignment:{taskId:'assigned',title:'Inspect startup',delivered:true},accepted:1,failed:0,result:{taskId:'accepted',title:'Baseline',turn:1,outcome:'completed',summary:'A long result is not copied',truncated:false}}})
 assert.equal(JSON.stringify(inspection.work).includes('retain this body'),false)
 for(const tasks of [{wrong:assigned},{assigned,other:{...assigned,id:'other'}},{assigned:{...assigned,state:{...assigned.state,workerSessionId:'foreign'}}}])assert.throws(()=>parseInspection({...value,swarm:{...team(),tasks}}))
})

const {parseWorkerDetail}=registration.factory()
test('worker detail decodes only reported model and bounded public text, never reasoning',()=>{
 const value={events:[{event:{type:'assistant/message',time:1000,data:{message:{content:[{type:'reasoning',text:'SECRET'},{type:'text',text:'A'.repeat(3000)}]}}}},{event:{type:'turn/end',time:1100,data:{reason:{kind:'completed'}}}}],projections:{values:{sessionStats:{activeThroughput:{provider:'ds',model:'flash'}}}}}
 const detail=parseWorkerDetail(value)
 assert.deepEqual(plain(detail),{model:{provider:'ds',model:'flash'},activity:{text:'Turn completed',time:1100},answer:{text:'A'.repeat(2000),truncated:true}})
 assert.equal(JSON.stringify(detail).includes('SECRET'),false)
 assert.deepEqual(plain(parseWorkerDetail({events:[]})),{model:null,activity:null,answer:null})
 for(const broken of [null,{events:{}},{events:[{event:{type:'assistant/message',time:1000,data:{content:[]}}}]},{events:[{event:{type:'tool/call',time:1,data:{name:42}}}]},{...value,projections:{values:{sessionStats:{activeThroughput:{provider:3,model:'flash'}}}}}])assert.throws(()=>parseWorkerDetail(broken))
})
test('inspector progress counts rejected work separately and orders results by worker turn',()=>{
 const settled=(id,turn,outcome,summary)=>({id,title:id,state:{status:'settled',workerSessionId:'child',messageId:'m-'+id,turn,outcome,summary}})
 const tasks={z:settled('z',1,'completed','Old result'),a:settled('a',5,'failed','New'.repeat(1000)),p:{id:'p',state:{status:'pending'}}}
 const inspection=parseInspection({swarm:{...team(),tasks},workers:[observation()]})
 assert.deepEqual(plain(inspection.progress),{total:3,pending:1,assigned:0,accepted:1,failed:1})
 assert.equal(inspection.work.child.result.turn,5)
 assert.equal(inspection.work.child.result.summary.length,2000)
 assert.equal(inspection.work.child.result.truncated,true)
})
test('selected worker detail uses only the existing parent-addressed read endpoint',async()=>{
 const calls=[],signal=new AbortController().signal
 const client=new SwarmClient({call:async(...args)=>{calls.push(args);return {ok:true,value:{events:[]}}}})
 await client.workerDetail({parentSessionId:'owner',childSessionId:'child',mode:'continuable'},signal)
 assert.deepEqual(plain(calls[0].slice(0,3)),['/api','subagent.history',{parentSessionId:'owner',childSessionId:'child',mode:'continuable',maxMessages:1}])
 assert.equal(calls[0][3],signal)
})
