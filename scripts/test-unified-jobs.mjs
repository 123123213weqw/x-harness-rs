import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
const require=createRequire(new URL('../ui/package.json',import.meta.url))
const {buildSync}=require('esbuild')
function load(file) {
  const code=buildSync({entryPoints:[new URL(`../ui/src/modules/jobs/${file}`,import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text
  const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,Error,JSON,Array,Map,Set,Number,Date,Promise,AbortController,setTimeout,clearTimeout,console:{error(){}}});return module.exports
}
const {JobClient}=load('client.ts'),model=load('model.ts')
const run=(extra={})=>({id:'bash-generation-1',label:'fixture process',sourceSessionId:'a',targetSessionId:'a',planId:null,state:'running',reference:{kind:'process',id:'bash-generation-1'},capabilities:{cancelRun:true,readOutput:true,openSession:false},startedAtMs:1,scheduledAtMs:null,finishedAtMs:null,detail:null,...extra})
const catalog=(extra={})=>({version:1,sessionId:'a',plans:[],runs:[run()],...extra})
const plain=v=>JSON.parse(JSON.stringify(v))
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
test('Committed v1 fixture is shared with the Rust DTO roundtrip regression',()=>{
  const fixture=JSON.parse(readFileSync(new URL('../fixtures/job-contract-v1.json',import.meta.url),'utf8'))
  assert.deepEqual(plain(model.parseCatalog(fixture,'fixture-owner')),fixture)
})
test('Job contract: plan completion is not run completion; actual start is not due time',()=>{
  const v=model.parseCatalog(catalog({plans:[{id:'p',label:'future',state:'finished',nextAt:'2026-10-13T00:00:00Z',everySeconds:null}],runs:[run({id:'schedule:a:p:one',planId:'p',reference:{kind:'automation',planId:'p',inputId:'schedule:a:p:one'},startedAtMs:null,scheduledAtMs:1791849600000,capabilities:{cancelRun:false,readOutput:false,openSession:true}})]}),'a')
  assert.equal(v.plans[0].state,'finished');assert.equal(v.runs[0].state,'running');assert.equal(v.runs[0].startedAtMs,null)
})
test('Job contract: unsupported versions, foreign owners, duplicate IDs and invalid states fail',()=>{
  for(const v of [catalog({version:2}),catalog({sessionId:'b'}),catalog({runs:[run(),run()]}),catalog({runs:[run({state:'success'})]}),catalog({runs:[run({sourceSessionId:'b'})]}),catalog({runs:[run({reference:{kind:'process',id:'other'}})]})])assert.throws(()=>model.parseCatalog(v,'a'))
})
test('Job output: both cursor and execution identity must match the requested run',()=>{
  const value={version:1,stdout:'<script>text</script>',stderr:'',stdoutTruncated:false,stderrTruncated:false,nextCursor:{job_id:'bash-generation-1',stdout:1,stderr:0},run:run()}
  assert.equal(model.parseOutput(value,'a',run().reference).stdout,'<script>text</script>')
  for(const v of [{...value,nextCursor:{job_id:'new-generation-1',stdout:0,stderr:0}},{...value,run:run({id:'other'})},{...value,version:2}])assert.throws(()=>model.parseOutput(v,'a',run().reference))
})
test('Tool history supplies only an ID hint, never a trusted execution state',()=>{
  const block={kind:'tool-result',content:[{type:'text',text:JSON.stringify({ok:true,content:JSON.stringify({job_id:'old-id',status:'completed'})})}]}
  assert.equal(model.processHint(block),'old-id')
  assert.equal(model.processHint({...block,isError:true}),undefined)
  assert.equal(model.processHint({content:[{type:'text',text:'{' }]}),undefined)
})
test('Shared session readers coalesce one request and stop after last unsubscribe',async()=>{
  const gate=deferred(),calls=[];const client=new JobClient({call(...args){calls.push(args);return gate.promise}})
  const a=client.subscribe('a',()=>{}),b=client.subscribe('a',()=>{})
  const p=client.refresh('a');assert.equal(p,client.refresh('a'));await Promise.resolve();assert.equal(calls.length,1)
  gate.resolve({ok:true,value:catalog()});await p;assert.equal(client.snapshot('a').catalog.runs[0].state,'running')
  a();b();assert.equal(calls[0][3].aborted,false)
})
test('Unsubscribe and identity reset fence even an RPC that ignores AbortSignal',async()=>{
  const first=deferred(),second=deferred();let count=0
  const client=new JobClient({call(){return ++count===1?first.promise:second.promise}})
  const off=client.subscribe('a',()=>{});const p=client.refresh('a');await Promise.resolve();off()
  const off2=client.subscribe('a',()=>{});const p2=client.refresh('a');await Promise.resolve()
  second.resolve({ok:true,value:catalog({runs:[run({id:'fresh',reference:{kind:'process',id:'fresh'},state:'completed'})]})});await p2
  first.resolve({ok:true,value:catalog()});await p;assert.equal(client.snapshot('a').catalog.runs[0].id,'fresh');off2()
})
test('Host disconnect clears old state and reconnect rebuilds a new generation',async()=>{
  const client=new JobClient({async call(){return {ok:true,value:catalog()}}})
  await client.refresh('a');client.reset(false);assert.equal(client.snapshot('a').catalog,undefined)
  await client.refresh('a');assert.match(client.snapshot('a').error,/connection/)
  client.reset(true);await client.refresh('a');assert.equal(client.snapshot('a').catalog.runs.length,1)
})
test('cancel_run is an acknowledgement, then stopping, not optimistic completed',async()=>{
  const calls=[];const client=new JobClient({async call(path,name,payload){calls.push([path,name,payload]);return {ok:true,value:payload.command.action==='list'?catalog({runs:[run({state:'stopping',capabilities:{cancelRun:false,readOutput:true,openSession:false}})]}):{version:1,accepted:true}}}})
  const off=client.subscribe('a',()=>{});await client.control('a',{action:'cancel_run',reference:run().reference})
  assert.equal(client.snapshot('a').catalog.runs[0].state,'stopping')
  assert.deepEqual(plain(calls.find(c=>c[2].command.action==='cancel_run')),['/api','job/manage',{sessionId:'a',command:{action:'cancel_run',reference:run().reference}}]);off()
})
test('cancel_future never sends cancel_run, and invalid receipts remain failures',async()=>{
  const calls=[];const client=new JobClient({async call(_path,_name,p){calls.push(p.command);return {ok:true,value:p.command.action==='list'?catalog():{version:1,accepted:true}}}})
  const off=client.subscribe('a',()=>{});await client.control('a',{action:'cancel_future',planId:'p'});assert.equal(calls[0].action,'cancel_future');assert.equal(client.snapshot('a').catalog.runs[0].state,'running');off()
  const bad=new JobClient({async call(){return {ok:true,value:{success:true}}}})
  await assert.rejects(bad.control('a',{action:'cancel_run',reference:run().reference}),/receipt/)
})
test('Listener reentrancy and listener exceptions do not duplicate reads or abort projection',async()=>{
  let calls=0;const client=new JobClient({async call(){calls++;return {ok:true,value:catalog({runs:[]})}}})
  let nested=false;const a=client.subscribe('a',()=>{if(!nested){nested=true;void client.refresh('a')}}),b=client.subscribe('a',()=>{throw Error('fixture listener')})
  await client.refresh('a');assert.equal(calls,1);assert.equal(client.snapshot('a').catalog.version,1);a();b()
})
