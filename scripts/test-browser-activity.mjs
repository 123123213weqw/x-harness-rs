// Real strict-compiled observer; only the native event transport is mocked.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'

const id='browser-activity-test'
const bytes=compileSourceModules(new URL('../ui/',import.meta.url).pathname,[{id,source:'src/modules/browser/model-activity.ts'}]).get(id).bytes.toString()
let module
vm.runInNewContext(bytes,{window:{__ModuleLoader__:{load:row=>{module=row.factory(()=>({}))}}}})
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const event=(patch={})=>({id:'1',backend:'embedded',owner:'chat-a',tabId:'browser:1',operation:'observe',phase:'started',...patch})

{
  let listener,stops=0
  const counts=[]
  const native={event:{listen:async(name,fn)=>{assert.equal(name,'xharness-browser-activity');listener=fn;return()=>stops++}}}
  const stop=module.listenModelBrowserActivity(native,'chat-a','browser:1',count=>counts.push(count))
  await tick()
  const send=patch=>listener({payload:event(patch)})
  for(const patch of [{backend:'headless'},{owner:'chat-b'},{tabId:'browser:2'},{operation:'eval'},{phase:'succeeded'},{id:3},{id:''},{owner:''},{backend:undefined}])send(patch)
  assert.deepEqual(counts,[0],'other backends, owners, tabs and malformed events never illuminate this page')
  send({});send({});send({id:'2',operation:'input'})
  assert.deepEqual(counts,[0,1,2],'duplicate start does not double-count; parallel calls remain visible')
  send({phase:'finished'});send({phase:'finished'});send({})
  assert.deepEqual(counts,[0,1,2,1],'an end clears only its invocation; a late start cannot resurrect it')
  send({id:'2',phase:'finished'})
  assert.equal(counts.at(-1),0)
  send({id:'3',phase:'finished'});send({id:'3'})
  assert.equal(counts.at(-1),0,'out-of-order finished-before-start stays finished')
  // Keep one genuine older call alive while evicting more than 128 finishes.
  send({id:'4'})
  for(let id=10;id<150;id++)send({id:String(id),phase:'finished'})
  send({id:'10'});send({id:'1'})
  assert.equal(counts.at(-1),1,'evicted finished IDs cannot resurrect; an already-active older call stays active')
  send({id:'4',phase:'finished'})
  assert.equal(counts.at(-1),0)
  send({id:'151'})
  assert.equal(counts.at(-1),1,'a newer invocation still illuminates the page after tombstone eviction')
  send({id:'152',operation:'request'});send({id:'153',operation:'read_response'})
  assert.equal(counts.at(-1),3,'HTTP and cached reads use the existing scoped activity indicator')
  stop()
  assert.equal(counts.at(-1),0,'unmount/chat/tab switch clears local presentation')
  assert.equal(stops,1)
  const previous=counts.length;send({id:'5'});send({id:'4',phase:'finished'})
  assert.equal(counts.length,previous,'late callbacks after disposal cannot update another pane')
}
{
  let resolveListen,stops=0
  const native={event:{listen:()=>new Promise(resolve=>{resolveListen=resolve})}}
  const stop=module.listenModelBrowserActivity(native,'chat-a','browser:1',()=>{})
  stop();resolveListen(()=>stops++);await tick()
  assert.equal(stops,1,'an async listener registered after disposal is unregistered too')
}
{
  const counts=[]
  const native={event:{listen:()=>Promise.reject(Error('transport unavailable'))}}
  const stop=module.listenModelBrowserActivity(native,'chat-a','browser:1',count=>counts.push(count))
  await tick();assert.deepEqual(counts,[0,0]);stop()
}
console.log('browser activity: scoped identity, concurrency, duplicate/out-of-order events and listener cleanup passed')
