import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {writeFileSync} from 'node:fs'
import {performance} from 'node:perf_hooks'
import {compile} from './conversation-test-harness.mjs'
import {runtimeTestSource} from './runtime-source-test-harness.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'scripts/ui-test-deps','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium',browser=await require('playwright')[engine].launch({headless:true})
const output=resolve(process.env.PROBE_OUTPUT??`dist/active-session-20261026/${engine}.json`);mkdirSync(resolve(output,'..'),{recursive:true})
const report={engine,kind:'real Runtime/Session/assembler/InputBar + React; isolated synthetic tool loop; immediate stub RPC; no real model/app',stages:[]}
try{
 const page=await browser.newPage({viewport:{width:900,height:600}}),errors=[]
 page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewPlatform(page,'source')
 await page.evaluate(()=>{document.body.innerHTML='<div id="root" style="padding:25px"></div>';window.registrations=[];window.__ModuleLoader__={load:module=>registrations.push(module)}})
 await page.addScriptTag({content:runtimeTestSource()});await page.addScriptTag({content:compile().test})
 await page.evaluate(()=>{
  const id='@xharness/dsh-client-runtime/client'
  window.realRuntime=registrations[0].factory(name=>{if(!(name in staticModules))throw Error('missing real dependency '+name);return staticModules[name]})
  window.api=registrations[1].factory(name=>name===id?realRuntime:(()=>{if(!(name in staticModules))throw Error('missing real dependency '+name);return staticModules[name]})())
  const definitions=[],views=[];let fallback
  api.registerConversationNodes({conversationEvents:{register:value=>definitions.push(value),registerFallback:value=>fallback=value},conversationViews:{register:value=>views.push(value)}})
  window.calls=[]
  window.gates={};const rpc=op=>async()=>{calls.push({op,time:performance.now()});if(gates[op])return new Promise(resolve=>{gates[op].resolve=resolve});return{result:{ok:true,value:{accepted:true}}}}
  window.session=new realRuntime.Session('isolated-browser-loop',{sessions:{cancel:rpc('stop'),prompt:rpc('send')}},{},{cooperativeEvents:true,conversation:{events:{entries:()=>definitions,fallbackEntry:()=>fallback},views:{entries:()=>views}}})
  session.installWindow([],false);session.openState='open';session.handleRunning(true)
  window.seq=0;window.nextStep=0;window.completed=0;window.currentTurn=0;window.turnGroup=128
  const send=(type,data,append=false)=>session.handleMuxEnvelope('fixture',{type:'session/event',event:{seq:seq++,time:Date.now(),type,data,...append?{surfaceOp:'append'}:{}}})
  send('turn/start',{turn:0});send('user/message',{message:{id:'u',role:'user',content:[{type:'text',text:'Private synthetic benchmark'}],source:{kind:'user'}}},true)
  window.addStep=()=>{const step=nextStep++,callId='c'+step,turn=Math.floor(step/turnGroup),coordinate=step%turnGroup
   if(turn!==currentTurn){send('turn/end',{turn:currentTurn,reason:{kind:'completed'}});send('turn/start',{turn});currentTurn=turn}
   send('step/start',{turn,step:coordinate});send('tool/call',{turn,step:coordinate,callId,name:'bash',arguments:'{"command":"echo synthetic"}'})
   send('tool/result',{turn,step:coordinate,message:{role:'tool',source:{kind:'tool',callId},content:[{type:'tool-result',content:[{type:'text',text:'Synthetic output '+'.'.repeat(2048)}],isError:false}]}},true)
   send('assistant/message',{turn,step:coordinate,message:{id:'a'+step,role:'assistant',content:[{type:'text',text:'Synthetic answer '+step}]}},true);send('step/end',{turn,step:coordinate});completed++
  }
  window.settle=async()=>{while(session.delivery.timer!==undefined)await new Promise(resolve=>setTimeout(resolve,0));session.getSnapshot()}
  window.fill=async count=>{const begin=performance.now();while(completed<count){for(let n=0;n<10&&completed<count;n++)addStep();await settle();await new Promise(resolve=>setTimeout(resolve,0))}return performance.now()-begin}
  window.burst=()=>{const begin=performance.now();for(let n=0;n<20;n++)addStep();window.lastBurstMs=performance.now()-begin}
  window.shell=new api.SessionInputShell({actx:{},defaultSink:text=>session.prompt([{type:'text',text}],'queue')})
  const hook=store=>selector=>React.useSyncExternalStore(fn=>store.subscribe(fn),()=>selector(store.getSnapshot()))
  const t=(key,args)=>{let text=api.en[key]??key;for(const[k,v]of Object.entries(args??{}))text=text.replaceAll('{'+k+'}',String(v));return text}
  const props={sessionId:'isolated-browser-loop',useSession:hook(session),useInput:hook(shell.state),inputActions:shell.actions,keyboard:shell,useNotices:hook(shell.notices),useLexicon:hook(shell.lexicon),useMenuLauncher:()=>false,useProjection:(_key,select)=>select?select(undefined):undefined,t,stop:()=>session.cancel(),command:async()=>false,toggleCommandMenu:()=>{},renderSlot:()=>null,resolveSubmitMode:()=> 'queue'}
  window.root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(api.InputBar,props))
  window.measure=()=>({steps:completed,events:session.events.length,nodes:session.getSnapshot().chat.order.length,contexts:session.conversation.contexts.size,heapMiB:performance.memory?.usedJSHeapSize/1048576})
 })
 const stop=page.getByRole('button',{name:'Stop generating',exact:true});await stop.waitFor({timeout:20000})
 const cdp=engine==='chromium'?await page.context().newCDPSession(page):undefined
 if(cdp)await cdp.send('HeapProfiler.collectGarbage')
 report.baselineHeapMiB=cdp?(await cdp.send('Runtime.getHeapUsage')).usedSize/1048576:undefined
 const stages=(process.env.PROBE_STAGES??'192,1088,4160,8256').split(',').map(Number)
 for(const n of stages){
  const fillMs=await page.evaluate(n=>fill(n),n),row={...await page.evaluate(()=>measure()),fillMs}
  delete row.heapMiB
  if(cdp){await cdp.send('HeapProfiler.collectGarbage');row.gcHeapMiB=(await cdp.send('Runtime.getHeapUsage')).usedSize/1048576}
  row.hotPath=await page.evaluate(async()=>{
   const a=session.conversation,index=a.locationIndex,counts={replays:0,resolutions:0},oldReplay=a.replayContext,oldResolve=index.resolve
   a.replayContext=function(...args){counts.replays++;return oldReplay.apply(this,args)}
   index.resolve=function(...args){counts.resolutions++;return oldResolve.apply(this,args)}
   addStep();await settle();a.replayContext=oldReplay;index.resolve=oldResolve;return counts
  })
  const beforeIdle=await page.evaluate(()=>calls.length),idle=performance.now();await stop.click();await page.waitForFunction(n=>calls.length>n&&calls.at(-1)?.op==='stop',beforeIdle);row.idleStopMs=performance.now()-idle;await page.evaluate(()=>{session.handleRunning(false);session.handleRunning(true)});await stop.waitFor()
  const beforeStop=await page.evaluate(()=>calls.length),bounds=await stop.boundingBox();await page.evaluate(()=>{window.burstScheduled=false;setTimeout(()=>{burstScheduled=true;burst()},10)})
  const start=performance.now();await page.waitForTimeout(15);await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.waitForFunction(n=>calls.length>n&&calls.at(-1)?.op==='stop',beforeStop);row.pressuredStopMs=performance.now()-start;row.burst20Ms=await page.evaluate(()=>lastBurstMs)
  await page.evaluate(()=>settle());
  // Also exercise the real send action with an already-ready draft.
  await page.evaluate(()=>{session.handleRunning(false);shell.setDraft('Synthetic queued message')});const send=page.getByRole('button',{name:'Send message',exact:true});await send.waitFor()
  const beforeSend=await page.evaluate(()=>calls.length),sb=await send.boundingBox();await page.evaluate(()=>setTimeout(burst,10));const ss=performance.now();await page.waitForTimeout(15);await page.mouse.click(sb.x+sb.width/2,sb.y+sb.height/2);await page.waitForFunction(n=>calls.length>n&&calls.at(-1)?.op==='send',beforeSend);row.pressuredSendMs=performance.now()-ss
  await page.evaluate(async()=>{await settle();session.handleRunning(true)});await stop.waitFor();report.stages.push(row);console.log(JSON.stringify(row));assert.ok(row.events<=4352,'bounded eligible multi-turn window');assert.ok(row.pressuredStopMs<2000&&row.pressuredSendMs<2000,'buttons remain responsive in the isolated burst')
 }
 // Delayed ACK/failure exercise the actual button/machine states, not a
 // substitute DOM button. The Host receipts below remain controlled stubs.
 await page.evaluate(()=>{session.handleRunning(false);session.handleRunning(true);gates.stop={}})
 const beforeGate=await page.evaluate(()=>calls.length)
 await stop.click()
 const stopping=page.getByRole('button',{name:'Stopping…',exact:true})
 await stopping.waitFor();assert.equal(await stopping.isDisabled(),true)
 assert.equal(await stopping.getAttribute('aria-busy'),'true')
 assert.equal(await stopping.locator('[data-composer-busy]').count(),1)
 await page.evaluate(()=>{void session.cancel();gates.stop.resolve({result:{ok:true,value:{accepted:true}}});delete gates.stop})
 assert.equal(await page.evaluate(()=>calls.length),beforeGate+1,'repeat stop is single-flight')
 assert.equal(await stopping.isDisabled(),true,'accepted ACK does not fake terminal state')
 await page.evaluate(()=>{session.handleRunning(false);shell.setDraft('Keep this draft on rejection');gates.send={}})
 await page.getByRole('button',{name:'Send message',exact:true}).click()
 const sending=page.getByRole('button',{name:'Sending…',exact:true})
 await sending.waitFor();assert.equal(await sending.isDisabled(),true)
 await page.evaluate(()=>{gates.send.resolve({result:{ok:false,error:{code:'rejected',message:'Controlled rejection'}}});delete gates.send})
 await page.getByRole('button',{name:'Send message',exact:true}).waitFor()
 assert.equal(await page.locator('textarea').inputValue(),'Keep this draft on rejection')
 report.controls={delayedStop:true,singleFlight:true,authoritativeCompletion:true,rejectedSendPreservesDraft:true}
 await page.evaluate(()=>session.handleRunning(true))
 const pacedMs=process.argv.includes('--soak')?30000:2000
 report.paced=await page.evaluate(async duration=>{
  const start=performance.now(),begin=completed
  while(performance.now()-start<duration){await fill(completed+10);await new Promise(r=>setTimeout(r,16))}
  await settle();return{elapsedMs:performance.now()-start,addedSteps:completed-begin,...measure()}
 },pacedMs)
 delete report.paced.heapMiB
 if(cdp){await cdp.send('HeapProfiler.collectGarbage');report.paced.gcHeapMiB=(await cdp.send('Runtime.getHeapUsage')).usedSize/1048576
  const late=report.stages.filter(row=>row.steps>=1088).map(row=>row.gcHeapMiB)
  assert.ok(Math.max(...late,report.paced.gcHeapMiB)-Math.min(...late)<5,'eligible multi-turn retained heap plateaus within 5 MiB')
 }
 assert.ok(report.paced.events<=4352)
 if(cdp){
  await cdp.send('HeapProfiler.collectGarbage');const before=(await cdp.send('Runtime.getHeapUsage')).usedSize/1048576
  await page.evaluate(()=>{root.unmount();session.delivery.clear();session.events=[];session.views=[];session.eventWeights=[];session.eventBytes=0;session.conversation.releaseWindow();session.notifier.notifyNow();session.getSnapshot()})
  await cdp.send('HeapProfiler.collectGarbage');report.fixtureWindowRelease={beforeMiB:before,afterMiB:(await cdp.send('Runtime.getHeapUsage')).usedSize/1048576}
 }
 report.errors=errors;assert.deepEqual(errors,[]);writeFileSync(output,JSON.stringify(report,null,2)+'\n')
}finally{await browser.close()}
