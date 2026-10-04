import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require = createRequire(new URL('../ui/package.json', import.meta.url))
const {buildSync} = require('esbuild')
function load(file, extra = {}) {
  const compiled = buildSync({entryPoints:[new URL(`../ui/src/modules/schedule/${file}`, import.meta.url).pathname], bundle:true, write:false, format:'cjs', platform:'node'}).outputFiles[0].text
  const module = {exports:{}}
  vm.runInNewContext(compiled, {module,exports:module.exports,Error,JSON,Array,Map,Set,Number,Date,AbortController,setTimeout,clearTimeout,...extra})
  return module.exports
}
const model = load('automation-card-model.ts'), {AutomationCardClient} = load('automation-card-client.ts')
const view = (overrides={}) => ({id:'a',prompt:'Test reminder',kind:'after',scheduledAt:'2026-10-05T12:00:00Z',state:'scheduled',automation:{mode:'reminder',target:'current_chat',paused:false},...overrides})
const block = (value,overrides={}) => ({kind:'tool-result',callId:'tool-1',call:{argsRaw:'{"action":"create"}',name:'automation'},content:[{type:'text',text:JSON.stringify({ok:true,content:JSON.stringify(value),error:'',truncated:false})}],isError:false,...overrides})
const plain = v => JSON.parse(JSON.stringify(v))
test('automation card: production nested envelope and direct domain JSON decode', () => {
  const data = model.automationCardModel(block(view()))
  assert.equal(data.action,'create'); assert.deepEqual(plain(data.ids),['a']); assert.equal(data.error,undefined)
  assert.equal(model.automationCardModel(block(view(),{content:[{type:'text',text:JSON.stringify(view())}]})).values[0].prompt,'Test reminder')
})
test('automation card: domain rejection is not transport success', () => {
  for (const value of [{code:'not_active',message:'Not active'}, {ok:false,error:{message:'Rejected'}}]) {
    const data = model.automationCardModel(block(value)); assert.ok(data.error); assert.equal(data.ids.length,0)
  }
  assert.ok(model.automationCardModel(block(view(), {isError:true,error:{name:'error',code:'Cancelled'}})).error)
  assert.ok(model.automationCardModel(block(view(), {content:[{type:'text',text:JSON.stringify({ok:false,error:'Failed',content:JSON.stringify(view())})}]})).error)
})
test('automation card: partial arguments, malformed / oversized results stay inspectable', () => {
  const running = model.automationCardModel({callId:'x',argsRaw:'{"action":',subCalls:[]})
  assert.equal(running.settled,false);assert.equal(running.action,'unknown')
  for (const text of ['{', 'x'.repeat(1_048_577)]) {
    const data = model.automationCardModel(block(null,{content:[{type:'text',text}]}))
    assert.equal(data.recognized,false);assert.equal(data.raw,text)
  }
})
test('automation card: list / delete receipts and invalid list are distinguished', () => {
  const empty = model.automationCardModel(block([],{call:{argsRaw:'{"action":"list"}'}}))
  assert.equal(empty.recognized,true);assert.equal(empty.ids.length,0)
  assert.deepEqual(plain(model.automationCardModel(block([view(), view({id:'b'})])).ids),['a','b'])
  assert.equal(model.automationCardModel(block([null])).recognized,false)
  assert.deepEqual(plain(model.automationCardModel(block({id:'a',deleted:true},{call:{argsRaw:'{"action":"delete","id":"a"}'}})).ids),['a'])
})
test('automation card: finished trigger is not completed task; refresh actual nonterminal runs', () => {
  const finished = model.automationView(view({state:'finished',runs:[{state:'running'}]}))
  assert.equal(finished.state,'finished');assert.equal(model.latestRunState(finished),'running');assert.equal(model.refreshDelay(finished),5000)
  assert.equal(model.refreshDelay(model.automationView(view({state:'finished',runs:[{state:'completed'}]}))),undefined)
  assert.equal(model.refreshDelay(model.automationView(view({state:'paused'}))),undefined)
  assert.equal(model.refreshDelay(model.automationView(view({state:'deleted'}))),undefined)
  assert.equal(model.latestRunState(model.automationView(view({state:'finished',runs:[]}))),undefined)
  for (const v of [null, view({state:'fake'}),view({scheduledAt:'invalid'})]) assert.equal(model.automationView(v),undefined)
})
test('automation card client: bound session and existing connection RPC, no extra model calls', async () => {
  const calls=[],notifications=[]
  const client = new AutomationCardClient({async call(...args){calls.push(args);return {ok:true,value:view({state:'paused'})}}})
  const offA=client.subscribe('a',()=>notifications.push('a')), offB=client.subscribe('b',()=>notifications.push('b'))
  const signal = new AbortController().signal
  await client.execute('a','a','pause',signal)
  assert.deepEqual(plain(calls[0].slice(0,3)),['/api','automation/manage',{sessionId:'a',command:{action:'pause',id:'a'}}])
  assert.equal(calls[0][3],signal);assert.deepEqual(notifications,['a'])
  await client.execute('b','a','view');assert.deepEqual(notifications,['a'])
  offA();offB();await client.execute('a','a','resume');assert.deepEqual(notifications,['a'])
})
test('automation card client: backend / network failures remain errors, not fake saved state', async () => {
  for (const response of [{ok:false,error:{message:'Host down'}},{ok:true,value:{code:'not_active',message:'Not active'}}]) {
    const client=new AutomationCardClient({async call(){return response}})
    await assert.rejects(()=>client.execute('a','a','pause'), /Host down|Not active/)
  }
})
test('automation card registration and effects fence late results and disposable listeners', () => {
  const source=readFileSync(new URL('../ui/src/modules/schedule/AutomationToolCard.tsx',import.meta.url),'utf8')
  assert.match(source,/if \(stopped\) return/);assert.match(source,/controller\?\.abort\(\)/);assert.match(source,/document\.hidden/)
  assert.match(source,/key=\{`\$\{sessionId\}:\$\{id\}`\}/);assert.match(source,/confirmDelete/)
  const index=readFileSync(new URL('../ui/src/modules/schedule/index.tsx',import.meta.url),'utf8')
  assert.match(index,/key: 'automation', locale: NS/)
  assert.ok(index.includes('"card.title": "Automation"')); assert.ok(index.includes('"card.title": "自动化"'))
})
function cardHarness(client, documentHidden=false) {
  const values=[],refs=[],effects=[],writes=[],listeners=new Map(),timeouts=new Map()
  let cursor=0
  const react={useMemo:fn=>fn(),useState(initial){const i=cursor++;if(!(i in values)) values[i]=initial;return [values[i],v=>{writes.push(i);values[i]=v}]},useReducer(fn,initial){const i=cursor++;if(!(i in values)) values[i]=initial;return [values[i],()=>{writes.push(i);values[i]=fn(values[i])}]},useRef(initial){const i=cursor++;if(!refs[i])refs[i]={current:initial};return refs[i]},useEffect:fn=>effects.push(fn)}
  const jsx=(type,props,key)=>({type,props,key})
  const document={hidden:documentHidden,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}
  const module={exports:{}}
  const code=buildSync({entryPoints:[new URL('../ui/src/modules/schedule/AutomationToolCard.tsx',import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime']}).outputFiles[0].text
  vm.runInNewContext(code,{module,exports:module.exports,require:id=>id==='react'?react:{jsx,jsxs:jsx},document,AbortController,setTimeout:(fn,ms)=>{timeouts.set(fn,ms);return fn},clearTimeout:fn=>timeouts.delete(fn),Date,JSON,Number,Array,Set,Error})
  const parent=module.exports.AutomationToolCard({block:block(view()),sessionId:'chat-a',useProjection:()=>[],client,t:key=>key==='card.locale'?'en':key})
  function find(node,predicate) {if(!node||typeof node!=='object')return undefined;if(Array.isArray(node)){for(const x of node){const r=find(x,predicate);if(r)return r}return} if(predicate(node))return node;return find(node.props?.children,predicate)}
  const saved=find(parent,node=>typeof node.type==='function'&&node.props?.id==='a')
  let tree
  const render=()=>{cursor=0;effects.length=0;tree=saved.type(saved.props);return tree}
  render()
  const cleanups=effects.map(fn=>fn()).filter(fn=>typeof fn==='function')
  return {document,listeners,timeouts,writes,render,find,unmount:()=>cleanups.forEach(fn=>fn()),get tree(){return tree}}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('automation card lifecycle: unmount aborts view and ignores late old-chat replies', async () => {
  let finish,signal,unsubscribed=false
  const client={subscribe:()=>()=>{unsubscribed=true},execute:(_chat,_id,_action,s)=>{signal=s;return new Promise(resolve=>{finish=resolve})}}
  const h=cardHarness(client);h.unmount();assert.equal(signal.aborted,true);assert.equal(unsubscribed,true);assert.equal(h.listeners.size,0)
  finish(view());await tick();assert.equal(h.writes.length,0);assert.equal(h.timeouts.size,0)
})
test('automation card lifecycle: hidden page makes no reads; visibility resumes and terminal states stop polling', async () => {
  let reads=0
  const h=cardHarness({subscribe:()=>()=>{},async execute(){reads++;return view({state:'finished',runs:[{state:'completed'}]})}},true)
  assert.equal(reads,0);h.document.hidden=false;h.listeners.get('visibilitychange')();await tick()
  assert.equal(reads,1);assert.equal(h.timeouts.size,0);h.unmount()
})
test('automation card lifecycle: same-render double click admits only one mutation', async () => {
  let writes=0,finish
  const h=cardHarness({subscribe:()=>()=>{},async execute(_chat,_id,action){if(action==='view')return view();writes++;return new Promise(resolve=>{finish=resolve})}})
  await tick();h.render()
  const button=h.find(h.tree,node=>node.type==='button'&&node.props.children==='card.pause')
  assert.ok(button);button.props.onClick();button.props.onClick();assert.equal(writes,1)
  finish(view({state:'paused'}));await tick();h.unmount()
})
test('automation card client: timed-out mutation aborts transport without a success receipt', async () => {
  let abort,cleared=false,notified=false
  const {AutomationCardClient: Client} = load('automation-card-client.ts',{setTimeout:fn=>{abort=fn;return 1},clearTimeout:()=>{cleared=true}})
  const client = new Client({call(_channel,_endpoint,_payload,signal){return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Timed out'))))}})
  client.subscribe('a',()=>{notified=true})
  const pending=client.execute('a','a','pause');abort();await assert.rejects(pending,/Timed out/)
  assert.equal(cleared,true);assert.equal(notified,false)
})
