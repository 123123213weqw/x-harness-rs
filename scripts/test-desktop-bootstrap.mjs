import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { compileScriptAssets } from './build-script-assets.mjs'
import { fileURLToPath } from 'node:url'

const ui = fileURLToPath(new URL('../ui', import.meta.url))
const source = compileScriptAssets(ui, [{source:'src/desktop/bootstrap.ts',path:'desktop-bootstrap.js'}]).get('desktop-bootstrap.js').bytes.toString('utf8')
const html = readFileSync(new URL('../apps/desktop/frontend/index.html', import.meta.url), 'utf8')
assert.ok(html.includes(source), 'local desktop document contains the source-fresh offline bundle')
assert.ok(html.includes(readFileSync(new URL('../ui/src/startup/surface.raw.css', import.meta.url), 'utf8')), 'local shell uses the shared stylesheet')
assert.doesNotMatch(html, /__XHARNESS_STARTUP_|@keyframes loading|#1F5EFF/)

class Node {
  constructor(tag) { this.tag=tag;this.children=[];this.dataset={};this.textContent='';this.isConnected=false }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children=nodes }
  setAttribute(name,value) { this[name]=value }
  decode() { return Promise.resolve() }
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function boot({startupError=null,eventFirst=false,rejectStatus=false,deferListen=false}={}) {
  const container=new Node('state'),calls=[],events=new Map(),pageEvents=new Map()
  let handler,resolveListen,unsubscribed=0
  const document={head:new Node('head'),hidden:false,
    getElementById:id=>id==='state'?container:new Node('style'),
    createElement:tag=>new Node(tag),addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)}
  vm.runInNewContext(source,{document,requestAnimationFrame:fn=>fn(),window:{
    addEventListener:(name,fn)=>pageEvents.set(name,fn),removeEventListener:()=>{},
    __TAURI__:{event:{listen:async(_name,fn)=>{
      calls.push('listen');handler=fn
      if(eventFirst)fn({payload:{phase:'failed',message:'live lock conflict'}})
      if(deferListen)await new Promise(resolve=>{resolveListen=resolve})
      return ()=>{unsubscribed++}
    }},core:{invoke:async command=>{calls.push(command);if(rejectStatus)throw Error('transport');return{startupError}}}},
  }})
  await tick()
  const root=container.children[0],copy=root.children[0].children[1],message=copy.children[1]
  return{root,message,calls,handler,close:()=>pageEvents.get('pagehide')(),finishListen:()=>resolveListen(),unsubscribed:()=>unsubscribed}
}
const missed=await boot({startupError:'state directory already owned'})
assert.ok('failed' in missed.root.dataset);assert.equal(missed.message.textContent,'state directory already owned')
assert.deepEqual(missed.calls,['listen','desktop_status','desktop_report_startup_phase'])
const live=await boot({eventFirst:true})
assert.ok('failed' in live.root.dataset);assert.equal(live.message.textContent,'live lock conflict')
live.handler({payload:{phase:'ready',message:'http://127.0.0.1:1234'}})
assert.equal(live.message.textContent,'live lock conflict','late ready cannot hide a failure')
const ready=await boot()
assert.ok(!('failed' in ready.root.dataset))
ready.handler({payload:{phase:'starting',message:'正在恢复历史会话…'}})
assert.equal(ready.message.textContent,'正在恢复历史会话…')
ready.handler({payload:{phase:'ready',message:'http://127.0.0.1:1234'}})
assert.equal(ready.message.textContent,'正在加载界面…','endpoint is not user-facing status')
ready.handler({payload:null});ready.handler({payload:'bad'});ready.handler({payload:{message:42}})
assert.equal(ready.message.textContent,'正在加载界面…')
ready.close();assert.equal(ready.unsubscribed(),1)
ready.handler({payload:{phase:'failed',message:'late'}})
assert.equal(ready.message.textContent,'正在加载界面…','disposed document ignores events')
const rejected=await boot({rejectStatus:true})
assert.ok('failed' in rejected.root.dataset);assert.match(rejected.message.textContent,/无法读取/)
const specific=await boot({eventFirst:true,rejectStatus:true})
assert.equal(specific.message.textContent,'live lock conflict','snapshot transport failure must not overwrite the specific live failure')
const race=await boot({deferListen:true})
race.close();race.finishListen();await tick()
assert.equal(race.unsubscribed(),1);assert.deepEqual(race.calls,['listen'],'late subscription is released without calling a disposed native bridge')
console.log('Desktop bootstrap: shared/offline build, missed/live errors, late ready, phase messages, invalid payload, rejection, unsubscribe and pagehide race passed.')
