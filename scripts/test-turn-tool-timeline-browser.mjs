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
// Independent real wire graph for paced recent-tool presentation.
const activitySession=api.session();activitySession.installWindow([],false);activitySession.openState='open'
let activitySeq=0
const wire=(type,data,append=false)=>{const event=terminalEvent(activitySeq++,type,data,append);event.time+=epoch;activitySession.acceptLiveEvent(event)}
const take=()=>terminalChatFixture(activitySession.getSnapshot().chat)
const start=(id,name,args)=>wire('tool/call',{turn:80,step:0,callId:id,name,arguments:JSON.stringify(args)})
const end=(id,error=false)=>wire('tool/result',{turn:80,step:0,message:{source:{callId:id},content:[{type:'tool-result',content:[{type:'text',text:error?'activity regression failed':'returned'}],isError:error}]}},true)
wire('turn/start',{turn:80});wire('step/start',{turn:80,step:0})
start('activity-a','read',{path:'first.css'});const activityOne=take()
end('activity-a');start('activity-b','grep',{pattern:'INTERMEDIATE_MUST_NOT_QUEUE'});const activityTwo=take()
end('activity-b');start('activity-c','bash',{command:'LATEST_ACTIVITY'});const activityLatest=take()
end('activity-c');start('p1','read',{path:'parallel-a.css'});start('p2','grep',{pattern:'parallel-search'});start('p3','todolist',{action:'get'});const activityParallel=take()
end('p1',true);const activityFailure=take()
start('recovered','read',{path:'RECOVERED_ACTIVITY'});const activityRecovery=take()
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
 // Observe actual short UI timeouts, without replacing their clock or callback behavior.
 await page.evaluate(()=>{
  const schedule=window.setTimeout.bind(window),cancel=window.clearTimeout.bind(window)
  window.activityTimers=new Set();window.activityTimerPeak=0
  const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document)
  window.activityListeners=new Map(['selectionchange','visibilitychange'].map(type=>[type,new Set()]))
  document.addEventListener=(type,listener,options)=>{activityListeners.get(type)?.add(listener);add(type,listener,options)}
  document.removeEventListener=(type,listener,options)=>{activityListeners.get(type)?.delete(listener);remove(type,listener,options)}
  window.setTimeout=(callback,delay,...args)=>{
   if(typeof callback!=='function')return schedule(callback,delay,...args)
   const id=schedule((...values)=>{activityTimers.delete(id);callback(...values)},delay,...args)
   if(delay>0&&delay<=1000){activityTimers.add(id);activityTimerPeak=Math.max(activityTimerPeak,activityTimers.size)}
   return id
  }
  window.clearTimeout=id=>{activityTimers.delete(id);cancel(id)}
 })
 await page.evaluate(()=>{window.registrations={};window.__ModuleLoader__={load:r=>registrations[r.id]=r}})
 for(const bytes of [modules.get('@test/path').bytes,modules.get('@test/tools').bytes,Buffer.from(conv.test)])await page.addScriptTag({content:bytes.toString()})
 const theme=['base.css','design-platform.css','scrollbar.css','gradient-shadow-text.css','typography.css','shiki.css'].map(name=>readFileSync('ui/src/modules/theme/'+name,'utf8')).join('\n')
 await page.addStyleTag({content:theme+'\n'+readFileSync('ui/overrides/monochrome.css','utf8')+'\nbody{margin:0}#fixture-scroll{height:720px;overflow-y:auto;overflow-anchor:none}#fixture-frame{max-width:960px;margin:auto}'})
 await page.evaluate(({thinking,thinkingMore,live,failed,closed,activityOne,activityTwo,activityLatest,activityParallel,activityFailure,activityRecovery})=>{
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
  window.fixtures={thinking,thinkingMore,live,failed,closed,activityOne,activityTwo,activityLatest,activityParallel,activityFailure,activityRecovery}
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
  // React's root event delegation owns a document-wide selection listener. Keep
  // that exact control, but require every component-owned listener to be released.
  window.activityListenerBaseline=new Map([...activityListeners].map(([type,set])=>[type,new Set(set)]))
  D.flushSync(()=>root.render(h('div',{id:'fixture-scroll','data-conversation-scroll':'',children:h(C.ChatView,props)})))
  window.installFixture=name=>D.flushSync(()=>snapshot.set({...snapshot.getSnapshot(),running:name!=='closed',chat:hydrate(fixtures[name])}))
  window.activitySnapshot=snapshot;window.activityProps=props;
  window.installActivity=(name,extra={})=>D.flushSync(()=>snapshot.set({...snapshot.getSnapshot(),running:true,pending:[],stopRequested:false,openState:'open',chat:hydrate(fixtures[name]),...extra}))
  window.swapActivitySession=id=>{props.sessionId=id;D.flushSync(()=>root.render(h('div',{id:'fixture-scroll','data-conversation-scroll':'',children:h(C.ChatView,props)})))}
  window.renderGlyphs=()=>D.flushSync(()=>root.render(h('div',{id:'glyph-probe'},['thought','read','write','edit','grep','bash','computer','display','todolist','web_fetch','agent','plugin_skill'].map(name=>h(T.ToolGlyph,{key:name,name})))))
 },{thinking,thinkingMore,live,failed,closed,activityOne,activityTwo,activityLatest,activityParallel,activityFailure,activityRecovery});console.log('real fixture mounted')
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
 console.log('typography and narrow verified')
 await page.evaluate(()=>installActivity('activityOne'))
 const activity=page.locator('[data-tool-activity="80"]'),current=activity.locator('[data-tool-activity-current]')
 await current.waitFor();assert.match(await current.innerText(),/first.css/)
 await page.mouse.move(950,770)
 const activityHeader=page.locator('[data-live-tool-summary="80"]')
 await activityHeader.scrollIntoViewIfNeeded();await frame()
 const geometryBefore=await activityHeader.boundingBox(),ringBefore=await page.locator('[data-xh-loading-ring]').elementHandle()
 await page.evaluate(()=>{installActivity('activityTwo');installActivity('activityLatest')})
 await page.waitForFunction(()=>document.querySelector('[data-tool-activity="80"] [data-tool-activity-current]')?.textContent.includes('LATEST_ACTIVITY'))
 const geometryAfter=await activityHeader.boundingBox()
 assert.equal(geometryAfter.height,geometryBefore.height,'tool pacing never changes the live header height')
 assert.equal(await page.locator('[data-xh-loading-ring]').evaluate((el,old)=>el===old,ringBefore),true,'same pixel ring DOM/animation owner')
 assert.equal(await page.getByRole('timer').count(),1,'no duplicate clock')
 assert.ok(await activity.locator('.xh-tool-activity-face').count()<=2,'no queued face pile')
 assert.ok(!(await current.innerText()).includes('INTERMEDIATE_MUST_NOT_QUEUE'))
 await page.evaluate(()=>installActivity('activityParallel'))
 await activity.locator('[data-tool-activity-parallel="3"]').waitFor()
 const ids=new Set()
 for(let i=0;i<3;i++){
  ids.add(await current.getAttribute('data-tool-activity-current'))
  const prior=await current.getAttribute('data-tool-activity-current')
  await page.waitForFunction(prior=>document.querySelector('[data-tool-activity="80"] [data-tool-activity-current]')?.getAttribute('data-tool-activity-current')!==prior,prior)
 }
 assert.ok(ids.size>=2,'parallel preview rotates actual active roots')
 await activityHeader.press('Enter');await page.locator('[data-tool="todolist"]').waitFor()
 assert.equal(await activity.isVisible(),false,'expansion removes the decorative animation, not the original cards')
 await activityHeader.press('Enter');await current.waitFor()
 // A keyboard reader holds a static face until leaving the summary control.
 const focusedId=await current.getAttribute('data-tool-activity-current')
 await page.waitForTimeout(1100);assert.equal(await current.getAttribute('data-tool-activity-current'),focusedId)
 await activityHeader.press('Tab');await page.mouse.move(950,770)
 // Fine-pointer hover and text selection must pause, rather than churn under a reader.
 await activity.hover();const hoverId=await current.getAttribute('data-tool-activity-current')
 await page.waitForTimeout(1100);assert.equal(await current.getAttribute('data-tool-activity-current'),hoverId)
 await page.mouse.move(950,770)
 await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('[data-tool-activity-pages]'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'))})
 const selectedId=await current.getAttribute('data-tool-activity-current')
 await page.waitForTimeout(1100);assert.equal(await current.getAttribute('data-tool-activity-current'),selectedId)
 await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'))})
 // Controlled page visibility is an input to the real hook, not a fake execution state.
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))})
 const hiddenId=await current.getAttribute('data-tool-activity-current')
 await page.waitForTimeout(1100);assert.equal(await current.getAttribute('data-tool-activity-current'),hiddenId)
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))})
 await page.evaluate(()=>installActivity('activityFailure'))
 await page.getByText('activity regression failed',{exact:true}).waitFor()
 assert.equal(await activity.isVisible(),false,'failure cancels both faces immediately')
 await page.evaluate(()=>installActivity('activityRecovery'))
 await current.waitFor();assert.match(await current.innerText(),/RECOVERED_ACTIVITY/)
 // Authoritative approval/question waits stop cosmetic paging. Original cards and timer stay present.
 await page.evaluate(()=>installActivity('activityParallel',{pending:[{kind:'approval',key:'controlled',payload:{toolName:'read',approvalId:'controlled',reason:'test'}}]}))
 assert.equal(await activity.isVisible(),false,'pending approvals suspend paging')
 assert.equal(await page.getByRole('timer').count(),1,'waiting does not remove the running turn clock')
 assert.ok(await page.locator('[data-chat-flow-kind="tool-call"]').count()>=3,'pending tools retain their original action/privacy seats')
 await page.evaluate(()=>installActivity('activityParallel',{pending:[{kind:'question',key:'controlled',payload:{}}]}))
 assert.equal(await activity.isVisible(),false)
 await page.evaluate(()=>installActivity('activityParallel',{stopRequested:true}));assert.equal(await activity.isVisible(),false)
 await page.evaluate(()=>installActivity('activityParallel',{openState:'error'}));assert.equal(await activity.isVisible(),false)
 await page.evaluate(()=>installActivity('activityParallel'));await current.waitFor()
 await page.emulateMedia({reducedMotion:'reduce'})
 const reducedId=await current.getAttribute('data-tool-activity-current')
 await page.waitForTimeout(1100);assert.equal(await current.getAttribute('data-tool-activity-current'),reducedId)
 assert.equal(await activity.locator('.xh-tool-activity-in,.xh-tool-activity-out').count(),0)
 await page.emulateMedia({reducedMotion:'no-preference'})
 await page.evaluate(()=>{installActivity('activityOne');swapActivitySession('activity-new-session')})
 await current.waitFor();assert.match(await current.innerText(),/first.css/);assert.equal(await activity.locator('.xh-tool-activity-out').count(),0,'session switch never replays outgoing old content')
 for(const width of [320,960]){
  await page.setViewportSize({width,height:780});await frame()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'paced header fits '+width)
 }
 if(output){await page.screenshot({path:join(output,engine+'-tool-activity.png'),fullPage:true})}
 console.log(engine+': coalesced latest tool, real parallel roots, focus/hover/selection/hidden/expansion, approval/question/error/stop/disconnect barriers, reduced motion, single stable clock/ring and session isolation passed')
 await page.evaluate(()=>renderGlyphs());await frame()
 assert.ok(await page.evaluate(()=>activityTimerPeak)>0,'the real timeout probe observed activity')
 await page.waitForFunction(()=>activityTimers.size===0)
 assert.equal(await page.locator('[data-tool-activity]').count(),0,'no stale activity subtree after unmount')
 assert.equal(await page.evaluate(()=>[...activityListeners].every(([type,set])=>set.size===activityListenerBaseline.get(type).size&&[...set].every(listener=>activityListenerBaseline.get(type).has(listener)))),true,'all component visibility/selection subscriptions disposed; exact React root control retained')
 assert.equal(await page.locator('[data-tool-glyph]').count(),12);assert.equal(await page.locator('[data-tool-glyph="search"]').count(),1)
 assert.deepEqual(errors.filter(e=>e!=='owned feature fixture: stop Host boot'),[])
 console.log(engine+': real assembled live/history, stable Thought, compact safety, manual/keyboard state retention, error/browser/todolist SVGs, ordinary typography, 320px and reader anchor passed')
}finally{await browser.close()}
