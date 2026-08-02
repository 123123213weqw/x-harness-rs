// Render actual source ChatView, keyed row seats and turn footer in both engines.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { exposeModuleUnit } from './fixtures/module-unit-scope.mjs'
import { compile } from './conversation-test-harness.mjs'
import { terminalHarness, terminalRow, terminalPrefix, terminalChatFixture } from './session-terminal-test-harness.mjs'
const deps=process.env.UI_TEST_DEPS??'/tmp/ui-tests'
const require=createRequire(resolve(deps,'package.json'))
const engines=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium'
const source=compile().test
const real = terminalHarness(source)
const terminalFixtures = JSON.parse(readFileSync(new URL('./fixtures/session-terminal.json', import.meta.url)))
const realWindows = terminalFixtures.cases.flatMap(item => ['live', 'history'].flatMap(mode => ['success', 'error', 'unknown'].map(outcome => {
 const session = real.session(), prefix = terminalPrefix(outcome)
 if (mode === 'live') {
  session.installWindow(prefix.map(terminalRow), false); session.openState = 'open'; session.acceptLiveEvent(item.live)
 } else session.installWindow([...prefix, item.history].map(terminalRow), false)
 return { name: `${item.name}-${mode}-${outcome}`, outcome, failure: item.live.data.reason.error?.message, chat: terminalChatFixture(session.getSnapshot().chat) }
})))
const toolBundle=exposeModuleUnit(readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-tool/client.js',import.meta.url),'utf8'),'tool','tool/components/ToolRow','ToolRow')
 .replace('return Object.assign({},__load("src/modules/tool/index.js"),{ToolRow:__load("src/modules/tool/tool/components/ToolRow.js")["ToolRow"]});','return __load("src/modules/tool/tool/components/ToolRow.js");')
const server=createServer((_,res)=>{res.setHeader('content-type','text/html');res.end('<html><body style="margin:0"><div id="root"></div></body></html>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await engines[engine].launch({headless:true})
try {
 const page=await browser.newPage({viewport:{width:950,height:700}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000)
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 for(const f of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(deps,'node_modules',f)})
 await page.addStyleTag({content:':root{--dsh-chat-content-width:760px;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#888;--dsw-alias-bg-base:#fff;--dsw-alias-state-business-primary:#4577e5}body{font:14px sans-serif}button{font:inherit}'} )
 await page.addScriptTag({content:'window.__ModuleLoader__={load:r=>window.registration=r}'})
 await page.addScriptTag({content:toolBundle})
 await page.evaluate(()=>window.toolRegistration=registration)
 await page.addScriptTag({content:source})
 await page.evaluate(()=>{
  const NativeObserver=ResizeObserver
  window.__foldObservers=new Set()
  window.ResizeObserver=class extends NativeObserver{
   constructor(callback){super(callback);__foldObservers.add(this)}
   disconnect(){__foldObservers.delete(this);super.disconnect()}
  }
  const NativeMutation=MutationObserver
  window.__foldMutations=new Set()
  window.MutationObserver=class extends NativeMutation{
   constructor(callback){super(callback);__foldMutations.add(this)}
   disconnect(){__foldMutations.delete(this);super.disconnect()}
  }
  const jsx=(type,props,key)=>React.createElement(type,key===undefined?props:{...props,key})
  const store=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;listeners.forEach(fn=>fn())}}}
  const runtime={isAppendSurfaceEvent:()=>true,toAssistantBlocks:x=>x,createSnapshotStore:store,defineStore:x=>x}
  const DisclosureRow=({open,onToggle,title,children})=>jsx('div',{children:[jsx('button',{onClick:onToggle,'aria-expanded':open,children:title}),open&&children]})
  const primitives=new Proxy({DisclosureRow,Tooltip:({children})=>children,MarkdownText:({text})=>jsx('div',{'data-md':'',children:text}),JsonBlock:({label})=>jsx('div',{children:label}),writeClipboard:async()=>true},{get:(o,k)=>o[k]??(()=>jsx('svg',{width:14,height:14}))})
  const plugin=registration.factory(name=>name==='react'?React:name==='react-dom'?ReactDOM:name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:React.Fragment}:name==='@xharness/dsh-client-ui-primitives'?primitives:name==='@xharness/dsh-client-runtime/client'?runtime:name==='@xharness/cordis'?{Service:class{}}:{})
  const toolApi=toolRegistration.factory(name=>name==='react'?React:name==='react-dom'?ReactDOM:name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:React.Fragment}:name==='@xharness/dsh-client-ui-primitives'?primitives:{})
  const t=(key,args={})=>(plugin.en[key]??key).replace(/\{(\w+)\}/g,(_,k)=>args[k])
  const hook=s=>select=>select(React.useSyncExternalStore(s.subscribe,s.getSnapshot))
  window.calls=[];window.sessionId='s';window.setId=id=>{sessionId=id;render()}
  window.snapshot=store({running:true,queue:[],openState:'open',openError:null,hasMore:false,loadingOlder:false,chat:{order:[],nodes:new Map(),timeline:{turns:new Map()},locations:{getTurn:()=>[]}}})
  const useSession=hook(snapshot),summaries=store({byId:{}}),details=store({})
  const turns=new Map(),nodes=new Map(),order=[]
  function add(turn,kind,key,data){const node={key,kind,data,anchorSeq:data.seq??data.finalNode?.seq??0,location:{kind:'turn',turn}};nodes.set(key,node);order.push(key)}
  const assistant=(text,seq,turn=1)=>{const blocks=[{kind:'reasoning',text:'thought '+text},{kind:'text',text}];return{status:'settled',turn,step:1,blocks,time:1000,finalNode:{kind:'assistant',turn,step:1,seq,time:1000,blocks}}}
  const tool=(name,callId,turn=1)=>({root:{kind:'tool-result',seq:3,time:1000,callId,callView:null,call:{name,argsRaw:'{}'},callTime:500,content:[],isError:false,resultView:null,subCalls:[]}})
  window.seed=()=>{
   nodes.clear();order.length=0;turns.clear()
   const turn={turn:1,start:{time:0},status:'open',end:undefined,data:new Map(),steps:[]};turns.set(1,turn)
   add(turn,'user','u1',{kind:'user',source:{kind:'user'},seq:1,time:0,content:[{type:'text',text:'user task'}]})
   add(turn,'compaction','compact1',{kind:'compaction',seq:2,time:800,summary:'saved summary',summaryEventSeq:2,shadowedItemCount:2,shadowedTokenCount:100})
   add(turn,'assistant-step','a1',assistant('intermediate reply',2))
   for(let i=0;i<80;i++)add(turn,'tool-call','job'+i,tool('bash '+i,'job'+i))
   add(turn,'assistant-step','final1',assistant('final answer',100))
   window.publish();
  }
  window.toolFixture=(key,options={})=>{
   const previous=nodes.get(key),root={...previous.data.root,...options}
   nodes.set(key,{...previous,data:{root}});publish()
  }
  window.seedFew=()=>{
   seed()
   for(let i=6;i<80;i++){nodes.delete('job'+i);order.splice(order.indexOf('job'+i),1)}
   publish()
  }
  window.appendTools=(count=10)=>{
   const turn=turns.get(1),start=order.length
   for(let i=0;i<count;i++)add(turn,'tool-call','extra'+(start+i),tool('extra bash','extra'+(start+i)))
   publish()
  }
  const liveNodes={get:key=>nodes.get(key),values:()=>[...nodes.values()]}
  window.publish=()=>snapshot.set({...snapshot.getSnapshot(),chat:{order:[...order],nodes:liveNodes,timeline:{turns:new Map(turns)},locations:{getTurn:id=>order.filter(k=>nodes.get(k).location.turn.turn===id)}}})
  window.finish=(closing=true,start=true,error=false)=>{
   const previous=turns.get(1),final=closing?nodes.get('final1').data:null
   const tail={turn:1,seq:110,time:165000,closing:final,branchUnavailable:false,ttftMs:200,tokensPerSecond:35}
   const turn={...previous,start:start?{time:0}:undefined,status:'closed',end:{time:165000},data:new Map([['turn-tail',tail]])};turns.set(1,turn)
   for(const [key,node] of nodes)nodes.set(key,{...node,location:{kind:'turn',turn}})
   if(error)add(turn,'turn-error','error1',{kind:'turn-error',seq:108,time:1000,turn:1,step:1,message:'network failed'})
   add(turn,'turn-tail','tail1',tail);snapshot.set({...snapshot.getSnapshot(),running:false});publish()
  }
  window.addSecondTurn=()=>{
   const final=assistant('second final answer',200,2),tail={turn:2,seq:210,time:2000,closing:final,branchUnavailable:false}
   const turn={turn:2,start:{time:1000},end:{time:2000},status:'closed',data:new Map([['turn-tail',tail]]),steps:[]};turns.set(2,turn)
   add(turn,'user','u2',{kind:'user',source:{kind:'user'},seq:150,time:1000,content:[{type:'text',text:'second user task'}]})
   add(turn,'tool-call','second-tool',tool('second bash','second-tool',2))
   add(turn,'assistant-step','final2',final);add(turn,'turn-tail','tail2',tail);publish()
  }
  window.dropWork=()=>{for(const key of ['u1','a1','job0','compact1']){nodes.delete(key);const i=order.indexOf(key);if(i>=0)order.splice(i,1)}publish()}
  window.injectMalformedTail=()=>{const old=turns.get(1),turn={...old,data:new Map([['turn-tail',{turn:1,closing:{}}]])};turns.set(1,turn);for(const [key,node] of nodes)nodes.set(key,{...node,location:{kind:'turn',turn}});publish()}
  window.injectForeignTail=()=>{const old=turns.get(1),turn={...old,data:new Map([['turn-tail',{...old.data.get('turn-tail'),turn:999}]])};turns.set(1,turn);for(const [key,node] of nodes)nodes.set(key,{...node,location:{kind:'turn',turn}});publish()}
  window.setFinalImage=()=>{const prev=nodes.get('final1'),blocks=[{kind:'image',attachment:{attachmentId:'image1',mediaType:'image/png',bytes:10}}];nodes.set('final1',{...prev,data:{...prev.data,blocks,finalNode:{...prev.data.finalNode,blocks}}});publish()}
  const owner={openFile:async()=>{},forkAt:()=>{},inspectCall:()=>{},loadOlder:()=>{},loadImage:async()=>'',chatScroll:{read:()=>null,save:()=>{}},fileMentions:()=>undefined,editMessage:()=>{},forkMessage:()=>{},t}
  const renderSlot=(key,props)=>{
   if(key==='conversation.message.images')return props.images.length===0?null:jsx('span',{'data-image':props.images.length,children:'final image'})
   if(key!=='conversation.chat.node')return null
   const base={...owner,...props,t,useSession,useTurnData:key=>props.node.location.turn.data.get(key),renderSlot:()=>null,renderSlotChain:()=>null}
   const component={'user':plugin.UserMessageNodeView,'assistant-step':plugin.AssistantNodeView,'turn-tail':plugin.TurnTailNodeView,'turn-error':plugin.TurnErrorNodeView,'compaction':plugin.CompactionNodeView}[props.node.kind]
   if(component)return jsx(component,base)
   if(props.node.kind==='tool-call')return jsx('div',{'data-tool-card':props.node.key,children:[
    jsx(toolApi.ToolRow,{stateKey:props.node.data.root.callId,t,variant:'bash',icon:null,title:props.node.data.root.call.name,summary:'completed',body:'tool input',output:'tool output',state:'ok'}),
    jsx('details',{'data-transcript-state-key':'native-tool','data-native-tool':props.node.key,children:[jsx('summary',{children:'Native details'}),jsx('div',{children:'native body'})]})
   ]})
   return jsx('div',{'data-extra':props.node.key,children:props.node.data.message??props.node.kind})
  }
  const root=ReactDOM.createRoot(document.getElementById('root'))
  window.render=()=>ReactDOM.flushSync(()=>root.render(jsx('div',{'data-conversation-scroll':'',style:{height:650,overflowY:'auto'},children:jsx(plugin.ChatView,{...owner,sessionId,useSession,useSessions:hook(summaries),useStore:hook(details),renderSlot})})))
  window.unmount=()=>root.unmount();seed();render()
  window.installRealWindow=(fixture,id)=>{
   const materialized=new Map(fixture.turns.map(turn=>[turn.turn,{...turn,data:new Map(turn.data),steps:turn.steps.map(step=>({...step,data:new Map(step.data)}))}]))
   const rows=new Map(fixture.nodes.map(node=>{
    const turn=materialized.get(node.location.turn),location={...node.location,turn}
    if(location.kind==='step')location.step=turn.steps.find(step=>step.step===node.location.step)
    return [node.key,{...node,location}]
   }))
   sessionId=id
   snapshot.set({...snapshot.getSnapshot(),running:false,chat:{order:fixture.order,nodes:{get:key=>rows.get(key),values:()=>[...rows.values()]},timeline:{turns:materialized},locations:{getTurn:id=>fixture.order.filter(key=>rows.get(key).location.turn.turn===id)}}})
   render()
  }
 })
 // In-flight process stays visible even if Session running briefly flips false.
 assert.equal(await page.locator('[data-turn-process-summary]').count(),0)
 const scroll=page.locator('[data-conversation-scroll]')
 const finalThink=page.locator('[data-chat-flow-key="final1"] [data-variant=think] button')
 await finalThink.waitFor();await finalThink.click();assert.equal(await finalThink.getAttribute('aria-expanded'),'true')
 await page.evaluate(()=>snapshot.set({...snapshot.getSnapshot(),running:false}))
 await page.locator('[data-chat-flow-key="a1"]').waitFor({state:'attached'})
 await page.evaluate(()=>finish())
 const summary=page.locator('[data-turn-process-summary="1"]')
 // Linux WebKit may serialize the decorative SVG's final line break in
 // innerText. Compare the complete label, without that browser-only suffix.
 await summary.waitFor();assert.equal((await summary.innerText()).trim(),'Ran for 2m 45s')
 assert.equal(await summary.getAttribute('aria-expanded'),'false')
 assert.equal(await page.locator('[data-tool-card]').count(),0)
 assert.equal(await page.getByText('intermediate reply',{exact:true}).count(),0)
 assert.equal(await page.locator('[data-variant=think]').count(),0)
 await page.getByText('final answer',{exact:true}).waitFor()
 await page.mouse.move(900,10);assert.equal(await summary.evaluate(e=>getComputedStyle(e).opacity),'1')
 // Keyboard reopen and close: same footer retains focus and process stores are unchanged.
 const bytes=await page.evaluate(()=>JSON.stringify(snapshot.getSnapshot().chat.nodes.values()))
 const topBefore=await summary.evaluate(e=>e.getBoundingClientRect().top)
 await summary.focus();await summary.press('Enter');await page.locator('[data-chat-flow-key="a1"]').waitFor({state:'attached'})
 await page.waitForTimeout(150)
 assert.ok(Math.abs((await summary.evaluate(e=>e.getBoundingClientRect().top))-topBefore)<3,'expansion keeps its scroll anchor')
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),80)
 assert.equal(await summary.getAttribute('aria-expanded'),'true')
 assert.equal(await summary.evaluate(e=>document.activeElement===e),true)
 const firstThink=page.locator('[data-chat-flow-key="a1"] [data-variant=think] button')
 assert.equal(await firstThink.getAttribute('aria-expanded'),'false','final/intermediate reasoning block keys do not alias')
 await firstThink.click()
 const compactButton=page.locator('[data-chat-flow-key="compact1"] button').first();await compactButton.click()
 await page.getByText('saved summary',{exact:true}).waitFor()
 // Actual ToolRow and native details keep independent choices through whole-turn
 // unmounts, rather than just surviving ordinary viewport windowing.
 const job0=page.locator('[data-tool-card="job0"]'),jobButton=job0.locator('[data-variant=bash] button').first()
 await jobButton.click();assert.equal(await jobButton.getAttribute('aria-expanded'),'true')
 const native=job0.locator('details');await native.locator('summary').click()
 await page.waitForFunction(()=>document.querySelector('[data-native-tool="job0"]').open===true)
 // Wait for native toggle delivery before the ancestor is unmounted.
 await page.waitForTimeout(40)
 await summary.press('Enter');assert.equal(await summary.getAttribute('aria-expanded'),'false')
 assert.equal(await page.evaluate(()=>JSON.stringify(snapshot.getSnapshot().chat.nodes.values())),bytes)
 // Collapsing a short transcript must not silently re-arm bottom follow. Model
 // content/image/font reflow below the entry must not drag the reader down.
 const resizeFrames=await page.evaluate(async()=>{
  const port=document.querySelector('[data-conversation-scroll]'),row=document.querySelector('[data-chat-flow-key="final1"]')
  const before=port.scrollTop;row.style.height='2000px'
  const tops=[];for(let i=0;i<16;i++)await new Promise(resolve=>requestAnimationFrame(()=>{tops.push(port.scrollTop);resolve()}))
  row.style.height='';return {before,tops}
 })
 assert.ok(resizeFrames.tops.every(top=>Math.abs(top-resizeFrames.before)<2),JSON.stringify(resizeFrames))
 // Two collapse/reopen cycles preserve both kinds of tool details.
 for(let n=0;n<2;n++){
  await summary.click();await jobButton.waitFor();assert.equal(await jobButton.getAttribute('aria-expanded'),'true')
  assert.equal(await native.evaluate(e=>e.open),true)
  assert.equal(await firstThink.getAttribute('aria-expanded'),'true','intermediate Think survives complete row unmount')
  assert.equal(await compactButton.getAttribute('aria-expanded'),'true','compaction choice survives complete row unmount')
  assert.equal(await page.locator('[data-tool-card="job1"] [data-variant=bash] button').first().getAttribute('aria-expanded'),'false','sibling tools retain independent choices')
  assert.equal(await page.locator('[data-native-tool="job1"]').evaluate(e=>e.open),false)
  assert.ok(await page.locator('[data-tool-card]').count()<30,'reopen does not mount the entire turn')
  await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight})
  await finalThink.waitFor();assert.equal(await finalThink.getAttribute('aria-expanded'),'true','final Think survives end/fold/remount')
  await page.waitForFunction(()=>document.querySelector('[data-chat-flow-key="job0"]').dataset.transcriptMounted==='false')
  await scroll.evaluate(e=>{e.scrollTop=0});await summary.waitFor();await jobButton.waitFor()
  assert.equal(await jobButton.getAttribute('aria-expanded'),'true','tool state survives viewport eviction too')
  await summary.click()
 }
 // Session isolation and historical reopening default to folded.
 await summary.click();await page.evaluate(()=>setId('other'))
 await page.getByRole('button',{name:/Show this turn's work/}).waitFor()
 await page.evaluate(()=>addSecondTurn())
 const second=page.locator('[data-turn-process-summary="2"]')
 await second.waitFor();assert.equal(await second.getAttribute('aria-expanded'),'false')
 await second.click();await page.locator('[data-chat-flow-key="second-tool"]').waitFor()
 assert.equal(await summary.getAttribute('aria-expanded'),'false')
 assert.equal(await page.locator('[data-chat-flow-key="job0"]').count(),0)
 await page.evaluate(()=>{setId('no-answer');seed();finish(false,false,true)})
 await page.getByRole('button',{name:/Show this turn's work/}).waitFor()
 assert.equal((await summary.innerText()).trim(),'Turn finished')
 await page.getByText('network failed',{exact:true}).waitFor()
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),0)
 await summary.click();await page.locator('[data-chat-flow-key="a1"]').waitFor({state:'attached'})
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),80)
 // Returning to the same numeric turn in another session cannot leak choices.
 await page.evaluate(()=>setId('s'));await summary.waitFor();assert.equal(await summary.getAttribute('aria-expanded'),'false')
 await summary.click();await jobButton.waitFor();assert.equal(await jobButton.getAttribute('aria-expanded'),'false')
 assert.equal(await native.evaluate(e=>e.open),false)
 // Partial history (old head unloaded) still has one usable resident entry.
 await page.evaluate(()=>dropWork());await page.locator('[data-turn-process-summary="1"]').waitFor()
 assert.equal(await page.locator('[data-turn-process-summary="1"]').count(),1)
 // Malformed/unknown tail fails open: keep all work inspectable, never discard it.
 await page.evaluate(()=>injectMalformedTail());await page.waitForFunction(()=>document.querySelectorAll('[data-turn-process-summary]').length===0)
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),79)
 // Even a structurally valid end record from another turn cannot hide this turn.
 await page.evaluate(()=>{setId('foreign-tail');seed();finish()});await summary.waitFor()
 await page.evaluate(()=>injectForeignTail());await page.waitForFunction(()=>document.querySelectorAll('[data-turn-process-summary]').length===0)
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),80)
 // An image-only final answer stays outside the process fold, like final text.
 await page.evaluate(()=>{setId('images');seed();setFinalImage();finish()})
 await summary.waitFor();assert.equal(await summary.getAttribute('aria-expanded'),'false')
 await page.getByText('final image',{exact:true}).waitFor();assert.equal(await page.locator('[data-tool-card]').count(),0)
 // Adaptive live folding is presentation only, and does not require turn/end.
 await page.evaluate(()=>{setId('adaptive');seed()})
 const live=page.locator('[data-live-tool-summary="1"]')
 await live.waitFor();await page.waitForTimeout(150)
 assert.equal(await live.getAttribute('aria-expanded'),'false')
 assert.ok(await page.locator('[data-chat-flow-kind="tool-call"]').count()<80)
 console.log('adaptive live fold:',JSON.stringify({engine,logicalTools:80,displayedToolRows:await page.locator('[data-chat-flow-kind="tool-call"]').count(),mountedHeavyCards:await page.locator('[data-tool-card]').count()}))
 assert.equal(await page.evaluate(()=>snapshot.getSnapshot().chat.nodes.values().length),84,'no tool/history content removed')
 await page.locator('[data-chat-flow-key="job79"]').waitFor({state:'attached'})
 // A previously folded root becoming pending/error must reappear immediately.
 await page.evaluate(()=>toolFixture('job0',{isError:true}))
 await page.locator('[data-chat-flow-key="job0"]').waitFor({state:'attached'})
 await page.locator('[data-chat-flow-key="job0"]').scrollIntoViewIfNeeded()
 await page.locator('[data-tool-card="job0"] button').first().focus()
 // Recovery is a fresh fold decision, never resurrection of a stale hidden
 // ID. Focus/selection/manual-open must survive the error/pending -> success
 // transition, including updates before the next observer animation frame.
 await page.evaluate(()=>{
  document.querySelector('[data-tool-card="job0"] button').focus()
  toolFixture('job0',{isError:false})
 })
 await page.waitForTimeout(100)
 assert.equal(await page.locator('[data-chat-flow-key="job0"]').count(),1,'focused recovered tool stays visible')
 assert.equal(await page.locator('[data-tool-card="job0"] button').first().evaluate(e=>e===document.activeElement),true)
 await page.evaluate(()=>toolFixture('job1',{subCalls:[{callId:'pending',callView:null,time:1,name:'ask_question',argsRaw:'{}',turn:1,step:1,subCalls:[]}]}))
 await page.locator('[data-chat-flow-key="job1"]').waitFor({state:'attached'})
 await page.locator('[data-chat-flow-key="job1"]').scrollIntoViewIfNeeded()
 await page.locator('[data-tool-card="job1"] details summary').click()
 await page.waitForFunction(()=>document.querySelector('[data-native-tool="job1"]').open)
 await page.evaluate(()=>{document.activeElement?.blur();toolFixture('job1',{subCalls:[]})})
 await page.waitForTimeout(100)
 assert.equal(await page.locator('[data-chat-flow-key="job1"]').count(),1,'manually opened recovered tool stays visible without focus')
 assert.equal(await page.locator('[data-native-tool="job1"]').evaluate(e=>e.open),true)
 await page.evaluate(()=>toolFixture('job2',{isError:true}))
 await page.locator('[data-chat-flow-key="job2"]').waitFor({state:'attached'})
 await page.locator('[data-chat-flow-key="job2"]').scrollIntoViewIfNeeded()
 await page.locator('[data-native-tool="job2"] summary').waitFor()
 await page.evaluate(()=>{
  const text=document.querySelector('[data-native-tool="job2"] summary').firstChild
  const range=document.createRange();range.selectNodeContents(text)
  getSelection().removeAllRanges();getSelection().addRange(range)
  toolFixture('job2',{isError:false})
 })
 await page.waitForTimeout(100)
 assert.equal(await page.locator('[data-chat-flow-key="job2"]').count(),1,'selected recovered tool stays visible')
 assert.ok(await page.evaluate(()=>getSelection().toString().length>0))
 await page.evaluate(()=>{
  document.activeElement?.blur();getSelection().removeAllRanges()
  toolFixture('job0',{isError:true})
  toolFixture('job1',{subCalls:[{callId:'pending',callView:null,time:1,name:'ask_question',argsRaw:'{}',turn:1,step:1,subCalls:[]}]})
 })
 // Explicit process expansion survives streaming, resize and turn/end.
 const raw=await page.evaluate(()=>JSON.stringify(snapshot.getSnapshot().chat.nodes.values()))
 await live.click();assert.equal(await live.getAttribute('aria-expanded'),'true')
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),80)
 assert.equal(await page.evaluate(()=>JSON.stringify(snapshot.getSnapshot().chat.nodes.values())),raw)
 await page.evaluate(()=>appendTools())
 await page.setViewportSize({width:650,height:550});await page.waitForTimeout(150)
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),90)
 await page.evaluate(()=>finish());await summary.waitFor()
 assert.equal(await summary.getAttribute('aria-expanded'),'true','manual choice is not overridden by end')
 await summary.click()
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),2,'failed/pending roots survive turn fold')
 // Refresh-style remount of the same final graph defaults folded without losing work.
 await page.evaluate(()=>setId('adaptive-replayed'))
 assert.equal(await summary.getAttribute('aria-expanded'),'false')
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),2)
 // An offscreen/zero-size viewport must not trigger speculative collapse.
 await page.evaluate(()=>{document.querySelector('[data-conversation-scroll]').style.height='0px';setId('zero');seed()})
 await page.waitForTimeout(120)
 assert.equal(await live.count(),0)
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),80)
 await page.evaluate(()=>document.querySelector('[data-conversation-scroll]').style.height='650px')
 await live.waitFor()
 assert.equal(await live.getAttribute('aria-expanded'),'false','new session does not inherit expanded choice')
 // Protect actual focused controls, selected text and user-opened native details.
 await page.evaluate(()=>{document.querySelector('[data-conversation-scroll]').style.height='4000px';setId('reading');seedFew()})
 await page.waitForFunction(()=>document.querySelectorAll('[data-tool-card]').length===6)
 assert.equal(await live.count(),0)
 await page.locator('[data-tool-card="job0"] details summary').click()
 await page.waitForFunction(()=>document.querySelector('[data-native-tool="job0"]').open)
 await page.locator('[data-tool-card="job1"] button').first().focus()
 await page.evaluate(()=>{
  const text=document.querySelector('[data-native-tool="job2"] summary').firstChild
  const range=document.createRange();range.selectNodeContents(text)
  getSelection().removeAllRanges();getSelection().addRange(range)
  document.querySelector('[data-conversation-scroll]').style.height='150px'
 })
 try { await live.waitFor() } catch (error) {
  console.error('protected fold geometry', await page.evaluate(() => {
   const port=document.querySelector('[data-conversation-scroll]'),selection=getSelection(),range=selection.rangeCount?selection.getRangeAt(0):null
   return {top:port.scrollTop,height:port.clientHeight,active:document.activeElement?.outerHTML,selection:selection.toString(),
    rows:[...document.querySelectorAll('[data-chat-auto-fold-turn]')].map(row=>({key:row.dataset.chatFlowKey,
     eligible:row.dataset.chatAutoFoldEligible,height:row.getBoundingClientRect().height,top:row.getBoundingClientRect().top,
     focused:row.contains(document.activeElement),selected:range?.intersectsNode(row)}))}
  }))
  throw error
 }
 await page.waitForTimeout(180)
 for(const key of ['job0','job1','job2','job5'])assert.equal(await page.locator('[data-chat-flow-key="'+key+'"]').count(),1,'protected '+key)
 await page.evaluate(()=>{document.activeElement.blur();getSelection().removeAllRanges()})
 await page.waitForFunction(()=>!document.querySelector('[data-chat-flow-key="job1"]')&&!document.querySelector('[data-chat-flow-key="job2"]'))
 assert.equal(await page.locator('[data-chat-flow-key="job0"]').count(),1,'manual-open protection survives focus release')
 // Offscreen reflow must not snap a reader anchor or permanently retain heavy cards.
 await page.evaluate(()=>document.querySelector('[data-conversation-scroll]').style.height='650px')
 await page.waitForTimeout(100)
 // The global two-mode policy controls live folding, completed-turn visibility
 // and individual Tool/Think disclosures, while heavy rows stay windowed.
 await page.evaluate(()=>{
  document.querySelector('[data-conversation-scroll]').style.height='650px'
  setId('mode-policy');seed()
  document.documentElement.dataset.xhProcessMode='expanded'
  window.dispatchEvent(new Event('xh-process-mode'))
 })
 await page.waitForFunction(()=>document.querySelectorAll('[data-chat-flow-kind="tool-call"]').length===80)
 assert.equal(await live.count(),0,'expanded mode disables live auto fold')
 await scroll.evaluate(e=>{e.scrollTop=0})
 await jobButton.waitFor()
 await page.waitForFunction(()=>document.querySelector('[data-tool-card="job0"] [aria-expanded]')?.getAttribute('aria-expanded')==='true')
 assert.equal(await firstThink.getAttribute('aria-expanded'),'true','expanded mode includes reasoning')
 await jobButton.click()
 await page.evaluate(()=>appendTools())
 await page.setViewportSize({width:720,height:550});await page.waitForTimeout(100)
 assert.equal(await jobButton.getAttribute('aria-expanded'),'false','manual collapse survives updates and resize')
 assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),90)
 await page.evaluate(()=>finish());await summary.waitFor()
 assert.equal(await summary.getAttribute('aria-expanded'),'true','completed work defaults expanded in expanded mode')
 assert.ok(await page.locator('[data-tool-card]').count()<30,'expanded mode keeps viewport windowing')
 await summary.click();assert.equal(await summary.getAttribute('aria-expanded'),'false','manual group collapse also works in expanded mode')
 assert.equal(await page.locator('[data-tool-card]').count(),0)
 // Switch while hidden, then back: stale manual choices cannot override a new
 // global default, including an unmounted old tool disclosure.
 await page.evaluate(()=>{document.documentElement.dataset.xhProcessMode='auto';window.dispatchEvent(new Event('xh-process-mode'))})
 await page.waitForTimeout(50)
 await page.evaluate(()=>{document.documentElement.dataset.xhProcessMode='expanded';window.dispatchEvent(new Event('xh-process-mode'))})
 await page.waitForFunction(()=>document.querySelector('[data-turn-process-summary="1"]')?.getAttribute('aria-expanded')==='true')
 await jobButton.waitFor();await page.waitForFunction(()=>document.querySelector('[data-tool-card="job0"] [aria-expanded]')?.getAttribute('aria-expanded')==='true')
 await page.evaluate(()=>{document.documentElement.dataset.xhProcessMode='auto';window.dispatchEvent(new Event('xh-process-mode'))})
 await page.waitForFunction(()=>document.querySelector('[data-turn-process-summary="1"]')?.getAttribute('aria-expanded')==='false')
 assert.equal(await page.locator('[data-tool-card]').count(),0)
 await page.evaluate(()=>{setId('mode-live-return');seed()})
 await live.waitFor();assert.equal(await live.getAttribute('aria-expanded'),'false','return to auto restarts bounded live folding')
 // Actual Rust fixtures pass through production Session/Assembler, not finish()'s
 // synthetic footer. Check every durable reason in both render modes, including
 // all errors and outcome-unknown protections (42 assembled windows per engine).
 for (const item of realWindows) {
  await page.evaluate(item=>installRealWindow(item.chat,'wire-'+item.name),item)
  const footer=page.locator('[data-turn-process-summary="1"]')
  await footer.waitFor();assert.equal((await footer.innerText()).trim(),'Ran for 2m 45s',item.name)
  assert.equal(await footer.getAttribute('aria-expanded'),'false')
  await page.getByText('answer',{exact:true}).waitFor()
  assert.equal(await page.locator('[data-chat-flow-kind="tool-call"]').count(),item.outcome==='success'?0:1,item.name)
  if(item.failure)await page.getByText(item.failure,{exact:true}).waitFor()
  await footer.click();assert.equal(await footer.getAttribute('aria-expanded'),'true')
  await page.locator('[data-chat-flow-kind="tool-call"]').waitFor()
 }
 await page.evaluate(()=>unmount())
 assert.equal(await page.evaluate(()=>__foldObservers.size),0,'all adaptive and window resize observers disposed on unmount')
 assert.equal(await page.evaluate(()=>__foldMutations.size),0,'adaptive mutation observer disposed on unmount')
 assert.deepEqual(errors,[])
 console.log(`${engine}: running/idle/turn-end fold, persistent footer, final answer, keyboard reopening/scroll anchor, no data mutation, session/turn isolation, Think/Tool/Compaction/native-details state, bounded remount, malformed/foreign tail, image-only/no-answer/unknown-start/error; adaptive height folding, latest/pending/failure protection, manual override, zero viewport, native-details/focus/selection protection and observer cleanup; 42 real Rust -> Session/Assembler -> DOM terminal windows passed`)
} finally {await browser.close();await new Promise(r=>server.close(r))}
