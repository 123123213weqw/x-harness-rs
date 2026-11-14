// Actual Session/Assembler projections + maintained ChatView/ToolRow/Markdown.
// No Host, model requests, real files, or input to the installed desktop app.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
import {compile} from './conversation-test-harness.mjs'
import {terminalHarness,terminalEvent,terminalChatFixture} from './session-terminal-test-harness.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
const conv=compile(),api=terminalHarness(conv.test),session=api.session()
session.installWindow([],false);session.openState='open'
let seq=0
const epoch=Date.now()-20_000
const send=(type,data,append=false)=>{const event=terminalEvent(seq++,type,data,append);event.time+=epoch;session.acceptLiveEvent(event)}
for(let turn=1;turn<12;turn++){
 send('turn/start',{turn});send('step/start',{turn,step:0})
 send('assistant/message',{turn,step:0,message:{id:'earlier-'+turn,content:[{type:'text',text:'Earlier completed response '+turn+'\n\n'+('History remains available. '.repeat(30))}]}},true)
 send('step/end',{turn,step:0});send('turn/end',{turn,reason:{kind:'completed'}})
}
const turn=12
send('turn/start',{turn});send('step/start',{turn,step:0})
send('assistant/chunk',{turn,step:0,chunk:{type:'reasoning-delta',index:0,text:'Check typography and tool boundaries.'}})
const thinking=terminalChatFixture(session.getSnapshot().chat)
for(let i=0;i<40;i++)send('assistant/chunk',{turn,step:0,chunk:{type:'reasoning-delta',index:0,text:' More thinking text.'}})
const thinkingMore=terminalChatFixture(session.getSnapshot().chat)
send('assistant/message',{turn,step:0,message:{id:'reasoning-0',content:[{type:'reasoning',text:'Check typography and tool boundaries.'}]}},true)
const call=(id,name,args)=>send('tool/call',{turn,step:0,callId:id,name,arguments:JSON.stringify(args)})
const result=(id,text,isError=false)=>send('tool/result',{turn,step:0,message:{source:{callId:id},content:[{type:'tool-result',content:[{type:'text',text}],isError}]}},true)
call('read-one','read',{path:'typography.css'});result('read-one','original file contents')
call('todo-one','todolist',{action:'update',revision:0,items:[{id:'verify',title:'Verify the UI'}]});result('todo-one','{"plan":{"revision":1,"items":[{"id":"verify","title":"Verify the UI","status":"pending"}]},"changed":true}')
call('shell-one','bash',{command:'verify fixture'})
const live=terminalChatFixture(session.getSnapshot().chat)
result('shell-one','{"ok":false,"error":"regression failed","content":"full failure evidence"}',true)
call('browser-one','plugin_mcp',{action:'call',plugin:'@xharness/native-browser',server:'webview',tool:'browser',arguments:{action:'snapshot'}})
const failed=terminalChatFixture(session.getSnapshot().chat)
result('browser-one','browser snapshot checked')
send('step/end',{turn,step:0});send('step/start',{turn,step:1})
send('assistant/message',{turn,step:1,message:{id:'final-answer',content:[{type:'reasoning',text:'Check the final rendering.'},{type:'text',text:'# Final answer\n\nOrdinary system typography with **clear hierarchy**.\n\n## Verification\n\nThe failure remains visible; this text does not assert the task passed.\n\n`const original = true`'}]}},true)
send('step/end',{turn,step:1});send('turn/end',{turn,reason:{kind:'completed'}})
const closed=terminalChatFixture(session.getSnapshot().chat)
const modules=compileSourceModules(resolve('ui'),[{id:'@test/tools',source:'src/modules/tool/test-exports.ts'},{id:'@test/path',source:'src/modules/client-runtime/workspaces/path.ts'}])
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'scripts/ui-test-deps','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium',output=process.env.UI_TEST_OUTPUT
assert.ok(['chromium','webkit'].includes(engine))
if(output)mkdirSync(output,{recursive:true})
const browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:960,height:780}}),errors=[]
 page.setDefaultTimeout(15000);page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message)});page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('owned feature fixture'))console.error('CONSOLE',m.text())})
 await installOwnedViewPlatform(page,'source');console.log('platform ready')
 await page.evaluate(()=>{window.registrations={};window.__ModuleLoader__={load:r=>registrations[r.id]=r}})
 for(const bytes of [modules.get('@test/path').bytes,modules.get('@test/tools').bytes,Buffer.from(conv.test)])await page.addScriptTag({content:bytes.toString()})
 const theme=['base.css','design-platform.css','scrollbar.css','gradient-shadow-text.css','typography.css','shiki.css'].map(name=>readFileSync('ui/src/modules/theme/'+name,'utf8')).join('\n')
 await page.addStyleTag({content:theme+'\n'+readFileSync('ui/overrides/monochrome.css','utf8')+'\nbody{margin:0}#fixture-scroll{height:720px;overflow-y:auto;overflow-anchor:none}#fixture-frame{max-width:960px;margin:auto}'})
 await page.evaluate(({thinking,thinkingMore,live,failed,closed})=>{
  const R=staticModules.react,D=staticModules['react-dom'],h=R.createElement
  const store=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},set:next=>{value=next;for(const f of listeners)f()}}}
  const runtime={...registrations['@test/path'].factory(),createSnapshotStore:store,defineStore:x=>x,toAssistantBlocks:x=>x,isAppendSurfaceEvent:()=>false}
  const load=name=>name==='@xharness/dsh-client-runtime/client'?runtime:staticModules[name]
  const C=registrations['@xharness/dsh-client-ui-conversation/test'].factory(load),T=registrations['@test/tools'].factory(load)
  const dictionary=C.en,t=(key,values={})=>(dictionary[key]??key).replace(/\{(\w+)\}/g,(_,k)=>String(values[k]??'{'+k+'}'))
  const hydrate=fixture=>{
   const turns=new Map(fixture.turns.map(turn=>[turn.turn,{...turn,data:new Map(turn.data),steps:turn.steps.map(s=>({...s,data:new Map(s.data)}))}]))
   const nodes=new Map(fixture.nodes.map(node=>{const loc=node.location,turn=turns.get(loc.turn);return[node.key,{...node,location:loc.kind==='step'?{kind:'step',turn,step:turn.steps.find(s=>s.step===loc.step)}:{kind:'turn',turn}}]}))
   return{order:fixture.order,nodes,timeline:{turns},locations:{getTurn:id=>fixture.nodes.filter(n=>n.location.turn===id).map(n=>n.key)}}
  }
  window.fixtures={thinking,thinkingMore,live,failed,closed}
  const snapshot=store({running:true,queue:[],openState:'open',openError:null,hasMore:false,loadingOlder:false,chat:hydrate(thinking)})
  const other=store({byId:{fixture:{cwd:'/fixture'}}}),selection=store({}),hook=s=>select=>select(R.useSyncExternalStore(s.subscribe,s.getSnapshot))
  const memory=new C.ChatScrollMemory(),useSession=hook(snapshot),useSessions=hook(other),useStore=hook(selection)
  const images=()=>null,no=()=>{},props={sessionId:'fixture',useSession,useSessions,useStore,t,openFile:async()=>{},loadOlder:async()=>{},loadImage:async()=>'',inspectCall:no,forkAt:no,fileMentions:()=>undefined,editMessage:no,forkMessage:no,chatScroll:memory.forSession('fixture')}
  const toolSlot=(_key,owner,options)=>owner.toolName==='todolist'?h(T.TodoRow,{...owner,t}):options.fallback
  props.renderSlot=(key,owner,options)=>{
   if(key!=='conversation.chat.node')return options?.fallback??null
   const node=owner.node,loc=node.location,turn=loc.turn
   const base={...owner,t,useSession,useSessions,useTurnData:key=>turn.data.get(key),renderMessageImages:images}
   switch(node.kind){
    case'assistant-step':return h(C.AssistantNodeView,base)
    case'tool-call':return h(T.ToolCallTree,{...base,useHostDescription:select=>select({home:'/fixture'}),renderSlot:toolSlot})
    case'turn-tail':return h(C.TurnTailNodeView,{...base,renderSlot:()=>null,renderSlotChain:()=>null})
    default:return h('div',{},node.kind)
   }
  }
  const host=document.getElementById('root');host.id='fixture-frame';const root=D.createRoot(host)
  D.flushSync(()=>root.render(h('div',{id:'fixture-scroll','data-conversation-scroll':'',children:h(C.ChatView,props)})))
  window.installFixture=name=>D.flushSync(()=>snapshot.set({...snapshot.getSnapshot(),running:name!=='closed',chat:hydrate(fixtures[name])}))
  window.renderGlyphs=()=>D.flushSync(()=>root.render(h('div',{id:'glyph-probe'},['thought','read','write','edit','grep','bash','computer','display','todolist','web_fetch','agent','plugin_skill'].map(name=>h(T.ToolGlyph,{key:name,name})))))
 },{thinking,thinkingMore,live,failed,closed});console.log('real fixture mounted')
 const frame=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const id=setTimeout(()=>reject(Error('animation frame deadline')),3000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(id);resolve()}))}))
 const group=page.locator('[data-live-tool-summary="12"]')
 await group.waitFor();assert.equal(await page.locator('[data-variant="think"]').count(),0,'live thought stays inside the collapsed round')
 console.log('thinking grouped');const before=await group.boundingBox();await page.evaluate(()=>installFixture('thinkingMore'));await frame();const after=await group.boundingBox()
 assert.equal(after.height,before.height,'reasoning deltas do not grow the collapsed header')
 await page.evaluate(()=>installFixture('live'));await page.locator('[data-tool="bash"]').waitFor();await frame();await frame()
 assert.equal(await page.locator('[data-tool="read"]').count(),0,'earlier settled reads are grouped even below the old 40% budget')
 assert.equal(await page.locator('[data-tool="todolist"]').count(),0,'earlier todo receipts are grouped')
 console.log('live compacted');await group.click();await page.locator('[data-tool="todolist"]').waitFor();await page.getByRole('button',{name:/Thought/}).first().press('Enter')
 assert.equal(await page.locator('[data-tool-glyph="thought"]').count(),1,'brain remains the thought identity while open')
 const todo=page.locator('[data-tool="todolist"]'),toggle=todo.locator('[aria-expanded]').first()
 assert.match(await todo.innerText(),/To-do list · 1 items/);assert.equal(await todo.locator('[data-tool-glyph="list"]').count(),1)
 await toggle.press('Enter');await todo.getByText(/"pending"/).waitFor();assert.equal(await todo.locator('[data-tool-glyph="list"]').count(),1,'open rows keep tool identity')
 // Native GTK wheel input can keep scrolling after mouse.wheel resolves.
 // Separate a completed reader gesture from the disclosure gesture; choose a
 // visible near-bottom anchor so the shorter transcript can still preserve it.
 const settleReader=async()=>{
  await page.evaluate(()=>{delete window.__timelineReader})
  await page.waitForFunction(()=>{
   const port=document.querySelector('#fixture-scroll'),header=document.querySelector('[data-live-tool-summary="12"]')
   const signature=[port.scrollTop,port.scrollHeight,header.getBoundingClientRect().top].join(':')
   const previous=window.__timelineReader,now=performance.now()
   if(!previous||previous.signature!==signature){window.__timelineReader={signature,time:now};return false}
   return now-previous.time>=160
  },null,{timeout:5000,polling:'raf'})
  await page.evaluate(()=>{delete window.__timelineReader})
 }
 await group.scrollIntoViewIfNeeded();await page.locator('#fixture-scroll').hover();await settleReader()
 const target=await page.locator('#fixture-scroll').evaluate(el=>el.getBoundingClientRect().bottom-54)
 await page.mouse.wheel(0,(await group.boundingBox()).y-target);await settleReader()
 const anchorBefore=await group.boundingBox(),rangeBefore=await page.locator('#fixture-scroll').evaluate(el=>({top:el.scrollTop,max:el.scrollHeight-el.clientHeight,height:el.clientHeight,bottom:el.getBoundingClientRect().bottom}))
 assert.ok(Math.abs(anchorBefore.y-target)<8,'real wheel must finish with a visible reader anchor before testing collapse')
 await group.click();await frame();await settleReader()
 const anchorAfter=await group.boundingBox(),rangeAfter=await page.locator('#fixture-scroll').evaluate(el=>({top:el.scrollTop,max:el.scrollHeight-el.clientHeight,height:el.clientHeight}))
 console.log('reader-anchor',JSON.stringify({before:anchorBefore,after:anchorAfter,rangeBefore,rangeAfter}))
 assert.equal(await page.locator('[data-tool="todolist"]').count(),0,'explicit group-close outranks previous child expansion, without erasing its state')
 assert.ok(Math.abs(anchorAfter.y-anchorBefore.y)<2,'disclosure preserves the reader anchor: '+JSON.stringify({before:anchorBefore,after:anchorAfter,rangeBefore,rangeAfter}))
 await group.click();await todo.waitFor();assert.equal(await toggle.getAttribute('aria-expanded'),'true','tool disclosure state survives round folding')
 console.log('expansion retained');await group.click();await page.evaluate(()=>installFixture('failed'));await frame()
 const shell=page.locator('[data-tool="bash"]');await shell.waitFor();await shell.getByText('regression failed',{exact:true}).waitFor()
 assert.equal(await shell.locator('[data-tool-glyph="terminal"]').count(),1,'failure badge does not replace the tool icon')
 assert.equal(await page.locator('[data-tool="plugin_mcp"] [data-tool-glyph="browser"]').count(),1,'exact browser MCP calls use a browser window')
 console.log('failure visible');await page.evaluate(()=>installFixture('closed'));await page.locator('[data-turn-process-summary="12"]').waitFor();await shell.waitFor()
 await page.getByRole('heading',{name:'Final answer',exact:true}).waitFor();assert.equal(await page.locator('[data-tool="todolist"]').count(),0,'closed rounds keep successful records folded')
 console.log('closed round verified');const font=await page.locator('[data-xh-assistant-prose] h1').last().evaluate(el=>({size:getComputedStyle(el).fontSize,weight:getComputedStyle(el).fontWeight,family:getComputedStyle(el).fontFamily}))
 assert.equal(font.size,'22px');assert.equal(font.weight,'600');assert.doesNotMatch(font.family,/Georgia|Songti|,\s*serif\b/)
 await page.locator('[data-turn-process-summary="12"]').click();await todo.waitFor();assert.equal(await toggle.getAttribute('aria-expanded'),'true','completion does not reset a call-owned disclosure')
 for(const width of [320,960]){
  await page.setViewportSize({width,height:780});await frame()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow at '+width)
 }
 if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click()
 await page.locator('[data-turn-process-summary="12"]').evaluate(el=>el.scrollIntoView({block:'start'}));await frame()
 await page.getByRole('heading',{name:'Final answer',exact:true}).scrollIntoViewIfNeeded();await frame()
 if(output){
  await page.screenshot({path:join(output,engine+'-turn-timeline.png'),fullPage:true})
  await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await frame()
  await page.screenshot({path:join(output,engine+'-turn-timeline-dark.png'),fullPage:true})
  await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'))
  writeFileSync(join(output,engine+'-typography.json'),JSON.stringify(font,null,2))
 }
 console.log('typography and narrow verified');await page.evaluate(()=>renderGlyphs());assert.equal(await page.locator('[data-tool-glyph]').count(),12);assert.equal(await page.locator('[data-tool-glyph="search"]').count(),1)
 assert.deepEqual(errors.filter(e=>e!=='owned feature fixture: stop Host boot'),[])
 console.log(engine+': real assembled live/history, stable Thought, compact safety, manual/keyboard state retention, error/browser/todolist SVGs, ordinary typography, 320px and reader anchor passed')
}finally{await browser.close()}
