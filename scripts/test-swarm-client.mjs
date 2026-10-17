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
const team=()=>({id:'s1',ownerSessionId:'owner',workspace:'/work',objective:'Fix startup',revision:1,status:'active',members:{child:{sessionId:'child',assignment:'Regression tests'}}})
const observation=()=>({sessionId:'child',activity:'idle',sessionRevision:0,lastTurnEnd:{kind:'completed'},unresolvedToolCalls:[],pendingMessages:0})
test('strict Swarm snapshots accept real schema and reject malformed identities/counts',()=>{
 assert.deepEqual(plain(parseTeam(team())),team())
 for(const bad of [null,[],{...team(),revision:0},{...team(),revision:1.5},{...team(),revision:Infinity},{...team(),status:'running'},{...team(),workspace:''},{...team(),members:{child:{sessionId:'other',assignment:'x'}}},JSON.parse('{"id":"s1","ownerSessionId":"owner","workspace":"/work","objective":"x","revision":1,"status":"active","members":{"__proto__":{"sessionId":"__proto__","assignment":"x"}}}')])assert.throws(()=>parseTeam(bad))
})
test('worker observations require exact membership, activity and safe nonnegative counters',()=>{
 const valid={swarm:team(),workers:[observation()]};assert.deepEqual(plain(parseInspection(valid)),valid)
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
