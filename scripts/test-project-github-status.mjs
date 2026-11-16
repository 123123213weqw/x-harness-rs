import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
const id='project-github-test',code=compileSourceModules('ui',[{id,source:'src/modules/workspace/project-github.ts'}]).get(id).bytes.toString()
let registration
vm.runInNewContext(code,{window:{__ModuleLoader__:{load:x=>registration=x}},AbortController,AbortSignal,Error,console})
const {parseProjectGitHub,ProjectStatusRequest,projectStatusReader}=registration.factory(name=>{throw Error(name)})
const a='a'.repeat(40),b='b'.repeat(40),ready={kind:'ready',ci:'passing',repository:'alice/project',branch:'feature',localSha:a,headSha:a,number:7,url:'https://github.com/alice/project/pull/7',state:'OPEN',draft:false}
test('project badges validate SHA, URL, enums and empty status before presentation',()=>{
 assert.equal(parseProjectGitHub(ready).ci,'passing')
 for(const change of [{ci:'green'},{localSha:b},{headSha:'bad'},{url:'https://evil.test'},{number:-1},{state:'future'},{branch:'bad\nbranch'},{repository:'../project'}])assert.throws(()=>parseProjectGitHub({...ready,...change}))
 for(const state of ['OPEN','CLOSED','MERGED'])assert.equal(parseProjectGitHub({...ready,state}).state,state)
 assert.equal(parseProjectGitHub({...ready,localSha:b,ci:'outdated'}).ci,'outdated')
 for(const kind of ['unsupported','ambiguous','no_pr']){assert.equal(parseProjectGitHub({kind,ci:'none'}).kind,kind);assert.throws(()=>parseProjectGitHub({kind,ci:'passing'}))}
})
test('fixed RPC uses workspace ID only, current carrier and caller cancellation',async()=>{
 const calls=[];const controller=new AbortController()
 const read=projectStatusReader({call:async(...args)=>{calls.push(args);return{ok:true,value:ready}}})
 await read('workspace-id',controller.signal);assert.equal(calls[0][0],'/api');assert.equal(calls[0][1],'github/project-status');assert.equal(JSON.stringify(calls[0][2]),'{"workspaceId":"workspace-id"}');controller.abort();assert.equal(calls[0][3].aborted,true)
 const failed=projectStatusReader({call:async()=>({ok:false,error:{message:'gh unavailable'}})});await assert.rejects(failed('w',new AbortController().signal),/gh unavailable/)
})
test('one in-flight refresh, no auto schedule, no cache after failure',async()=>{
 let resolve;const rows=[],calls=[];let fail=false
 const request=new ProjectStatusRequest(async(id,signal)=>{calls.push([id,signal]);if(fail)throw Error('auth expired');return await new Promise(done=>resolve=done)},'one')
 const publish=(...row)=>rows.push(row)
 const first=request.refresh(publish);await request.refresh(publish);assert.equal(calls.length,1);assert.equal(rows[0][2],true)
 resolve(ready);await first;assert.equal(rows.at(-1)[0].ci,'passing');fail=true;await request.refresh(publish);assert.equal(rows.at(-1)[0],undefined);assert.equal(rows.at(-1)[1],'auth expired');assert.equal(calls.length,2);request.dispose()
})
test('disposed old project/Host response never overwrites replacement',async()=>{
 let resolve;const rows=[];let signal
 const request=new ProjectStatusRequest(async(_id,s)=>{signal=s;return await new Promise(done=>resolve=done)},'old')
 const first=request.refresh((...v)=>rows.push(v));request.dispose();assert.equal(signal.aborted,true);resolve(ready);await first;assert.equal(rows.length,1);await request.refresh(()=>assert.fail('disposed refresh'));assert.equal(rows.length,1)
})
