import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { patchSessionHistoryCache } from './patch-session-history-cache.mjs';
const root = fileURLToPath(new URL('../',import.meta.url)), dist=resolve(root,'ui/dist');
const shipped=readFileSync(resolve(dist,'plugins/@xharness/dsh-client-runtime/client.js'));
new Script(shipped.toString());
assert.deepEqual(patchSessionHistoryCache(shipped),shipped);
assert.deepEqual(patchSessionHistoryCache(Buffer.from(shipped.toString().replace('Product-owned history residency','Older history residency'))),shipped);
assert.throws(()=>patchSessionHistoryCache(Buffer.from('upstream changed')),/anchor changed/);
const graph=JSON.parse(readFileSync(resolve(dist,'client-graph.json')));
const entry=graph.entries.find(e=>e.id==='@xharness/dsh-client-runtime');
assert.equal(entry.rev,createHash('sha256').update(shipped).digest('hex').slice(0,16));
assert.ok(readFileSync(resolve(dist,'index.html'),'utf8').includes(entry.url));
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'));
const engine=process.env.UI_TEST_BROWSER??'chromium';
const browser=await require('playwright')[engine].launch({headless:true});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const assets=readdirSync(resolve(dist,'assets')), index=readFileSync(resolve(dist,'index.html'),'utf8').match(/src="\/assets\/(index-[^"?]+\.js)/)[1];
 await page.route('**/*',route=>{
  const path=new URL(route.request().url()).pathname, name=path.slice('/assets/'.length);
  if(path.startsWith('/assets/')&&assets.includes(name))return route.fulfill({body:readFileSync(resolve(dist,'assets',name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'});
  if(path==='/')return route.fulfill({contentType:'text/html',body:`<script>window.__ModuleLoader__={create:o=>{window.staticModules=o.staticModules;throw Error('fixture stop boot')}};</script><script type="module" src="/assets/${index}"></script><div id="root"></div>`});
  return route.abort();
 });
 await page.goto('http://history.test/');await page.waitForFunction(()=>window.staticModules);
 await page.evaluate(()=>{window.registrations={};window.__ModuleLoader__={load:r=>{registrations[r.id]=r}}});
 for(const name of readdirSync(resolve(dist,'plugins/@xharness'))) {
  let source=readFileSync(resolve(dist,'plugins/@xharness',name,'client.js'),'utf8');
  if(name==='dsh-client-runtime')source=source.replace('exports.apply = apply;', 'exports.Session = Session; exports.SessionManager = SessionManager; exports.apply = apply;');
  if(name==='dsh-client-ui-conversation')source=source.replace('exports.apply = apply;', 'exports.ChatView = ChatView; exports.registerConversationNodes = registerConversationNodes; exports.apply = apply;');
  await page.addScriptTag({content:source});
 }
 const checks=await page.evaluate(async()=>{
  const cache={};function load(id){if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;return cache[name]??(cache[name]=registrations[name].factory(load))}
  const {SessionManager}=load('@xharness/dsh-client-runtime/client');window.SessionManager=SessionManager;
  const definitions=[],views=[];let fallback;
  load('@xharness/dsh-client-ui-conversation/client').registerConversationNodes({conversationEvents:{register:d=>definitions.push(d),registerFallback:d=>{fallback=d}},conversationViews:{register:d=>views.push(d)}});
  const conversation={events:{entries:()=>definitions,fallbackEntry:()=>fallback},views:{entries:()=>views}};
  window.atomicFixture = async () => {
    const row = seq => ({event:{seq,time:seq,type:'user/message',surfaceOp:'append',data:{id:String(seq),source:{kind:'user'},content:[{type:'text',text:'retained message'}],text:'retained message'}}});
    let invalid = false, calls = 0;
    const bad = ['compaction/summary','compaction/start'].map((type,index)=>({event:{seq:index+2,time:index+2,type,data:{compactionId:'broken'}}}));
    const api = {sessions:{history:async()=>{calls++;return {result:{ok:true,value:{events:invalid?[row(1),...bad]:[row(1)],hasMore:false}}}}}};
    const manager = new SessionManager(api, {}, undefined, undefined, conversation);
    manager.summaries.push({sessionId:'atomic',running:false,blank:false}); manager.select('atomic');
    const session = manager.get('atomic'); await session.open(); session.getSnapshot();
    const before = session.events, snapshot = session.conversation.snapshot('chat');
    invalid = true; await session.resync();
    if(session.events!==before || session.conversation.snapshot('chat')!==snapshot || session.openState!=='error') throw Error('real compaction classifier discarded the old window');
    const R=staticModules.react,D=staticModules['react-dom'],View=load('@xharness/dsh-client-ui-conversation/client').ChatView;
    const root=D.createRoot(document.getElementById('root'));
    const props={sessionId:'atomic',useSession:f=>f(session.getSnapshot()),useSessions:f=>f({byId:{atomic:{cwd:'/fixture'}}}),useStore:f=>f({}),t:k=>k,
      chatScroll:{read:()=>null,save:()=>{}},fileMentions:[],openFile:async()=>{},loadImage:async()=>{},inspectCall:()=>{},forkAt:()=>{},editMessage:()=>{},
      renderSlot:(_slot,owner)=>R.createElement('div',{'data-retained-message':owner.node.key},'retained message'),
      loadOlder:async()=>{invalid=false;await session.loadOlder();render();}
    };
    function render(){D.flushSync(()=>root.render(R.createElement(View,props)));}
    render();
    window.atomicState=()=>({calls,state:session.openState,events:session.events.length});
    window.atomicUnmount=()=>root.unmount();
  };
  let checks=0;function ok(v,m){if(!v)throw Error(m);checks++}
  const tick=()=>new Promise(r=>setTimeout(r,0));
  const row=seq=>({event:{seq,time:seq,type:'user/message',surfaceOp:'append',data:{id:String(seq),source:{kind:'user'},content:[{type:'text',text:'body '+seq}],text:'body '+seq}},view:{text:'view '+seq}});
  const pageOf=(before=201)=>{const start=Math.max(1,before-50);return {events:Array.from({length:before-start},(_,i)=>row(start+i)),hasMore:start>1}};
  const calls=[];
  const api={sessions:{history:async p=>{calls.push(p);return {result:{ok:true,value:pageOf(p.beforeSeq)}}},prompt:async()=>({result:{ok:true,value:{}}})},subagents:{list:async()=>({result:{ok:true,value:{entries:[],parentAvailable:true}}})}};
  const remote={commands:{execute:async()=>({ok:true})}};
  const manager=new SessionManager(api,remote,undefined,undefined,conversation);window.fixtureManager=manager;
  const select=id=>{if(!manager.summaries.some(s=>s.sessionId===id))manager.summaries.push({sessionId:id,running:false,blank:false,updatedAt:0});manager.select(id);return manager.get(id)};
  const a=select('a');await a.open();await a.loadOlder();await a.loadOlder();
  ok(a.baseSeq===51&&a.getSnapshot().chat.order.length===150,'loaded three pages with real Chat projection');
  a.actx={draft:'keep me',attachments:['file-ref'],expanded:['tool-1']};
  const assembler=a.conversation, oldEvents=new WeakRef(a.events);window.oldEvents=oldEvents;window.oldEvent=new WeakRef(a.events[0]);
  a.projections.apply('title','keep title',1);
  const b=select('b');await b.open();manager.xhHistoryCache.limits.maxInactiveSessions=0;
  manager.historyCacheStats();await tick();
  ok(a.openState==='cold'&&a.events.length===0&&a.views.length===0,'raw history evicted');
  ok(a.conversation===assembler&&assembler.inputs.size===0&&a.getSnapshot().nodes.length===0,'assembler and cached snapshot cleared, identity stable');
  ok(a.actx.draft==='keep me'&&a.actx.attachments[0]==='file-ref'&&a.projections.get('title')==='keep title','scope and projection state retained');
  const before=calls.length;select('a');await a.open();
  ok(a.baseSeq===51&&a.events.length===150&&calls.length===before+3,'restore full previous range for saved scroll anchors');
  ok(a.views[0].text==='view 51'&&a.events.at(-1).data.text==='body 200','restored wire data exact');
  ok(b.openState==='cold','other selected page became eligible');
  // Protection is state-based; pending waits are not silently answered or discarded.
  a.handleRunning(true);select('b');await b.open();manager.historyCacheStats();ok(a.openState==='open','running protected');
  a.handleRunning(false);a.pending.set('q',{kind:'question'});manager.historyCacheStats();ok(a.openState==='open','question protected');
  a.pending.clear();a.queueMirror.replace([{message:{id:'queued',content:[]},placement:'queue'}]);manager.historyCacheStats();ok(a.openState==='open','queue protected');
  a.queueMirror.reset();manager.trackPending('a','approval','pending');manager.historyCacheStats();ok(a.openState==='open','manager approval protected');
  manager.resolvePending('a','approval');manager.historyCacheStats();ok(a.openState==='cold','eligible once outstanding work settled');
  // Background deltas/status never touch lastAccess; selected cold session refetches.
  manager.xhHistoryCache.limits.maxInactiveSessions=2;
  select('a');await a.open();const last=manager.xhHistoryCache.entries.get('a').lastAccess;
  a.handleRunning(true);a.acceptLiveEvent(row(201).event,row(201).view);a.handleRunning(false);
  ok(manager.xhHistoryCache.entries.get('a').lastAccess===last,'background event does not renew LRU');
  for(const id of ['c','d','e']){const s=select(id);await s.open();}
  const stats=manager.historyCacheStats();ok(stats.inactiveSessions===2&&manager.get('a').openState==='cold','LRU count bound');
  manager.xhHistoryCache.limits.maxInactiveBytes=1;manager.historyCacheStats();ok(manager.historyCacheStats().inactiveSessions===0,'byte bound independent of count');
  // Pending HTTP operations are pinned, then trimmed on settle. No resurrection race.
  let release;const c=select('c');c.history=()=>new Promise(r=>{release=r});const opening=c.open();await tick();select('e');manager.historyCacheStats();
  ok(c.openState==='loading','inflight loading protected');release({result:{ok:true,value:pageOf()}});await opening;await tick();ok(c.openState==='cold','loading completion triggers eviction offstage');
  // Cold sessions are ignored on reconnect; no fetch-all cache resurrection.
  const count=calls.length;await c.resync();ok(calls.length===count&&c.openState==='cold','cold resync stays cold');
  // Restore failure remains explicit/retryable; never quietly reset to bottom.
  select('c');c.history=async p=>p.beforeSeq?{result:{ok:false,error:{message:'offline'}}}:{result:{ok:true,value:pageOf()}};
  c.xhRestoreBaseSeq=1;await c.open();ok(c.openState==='error'&&c.xhRestoreBaseSeq===1,'restore failure keeps anchor range and error');
  c.history=api.sessions.history;await c.open();ok(c.openState==='open'&&c.baseSeq===1,'restore retry succeeds');
  // Authoritative history is a projection: completed chunks disappear and
  // adjacent deltas may coalesce. Sparse seqs are valid when strictly ordered,
  // below beforeSeq, and non-overlapping across pages.
  const sparsePageOf=(before=201)=>{const start=Math.max(1,before-50);return {events:Array.from({length:before-start},(_,i)=>start+i).filter(seq=>seq%7!==3).map(row),hasMore:start>1}};
  c.xhRestoreBaseSeq=51;c.history=async p=>({result:{ok:true,value:sparsePageOf(p.beforeSeq)}});
  const sparse=await c.restoreHistoryRange(sparsePageOf(),c.openGeneration);
  ok(sparse.events[0].event.seq<=51&&sparse.events.at(-1).event.seq===200&&sparse.events.every((entry,i,all)=>i===0||entry.event.seq>all[i-1].event.seq),'sparse projected restore pages reach the saved anchor and stay ordered');
  c.xhRestoreBaseSeq=undefined;
  manager.summaries.push({sessionId:'sparse-older',running:false,blank:false,updatedAt:0});
  const sparseOlder=manager.get('sparse-older');sparseOlder.history=async p=>({result:{ok:true,value:sparsePageOf(p.beforeSeq)}});
  manager.select('sparse-older');await sparseOlder.open();const sparseBase=sparseOlder.baseSeq;await sparseOlder.loadOlder();
  ok(sparseOlder.baseSeq<sparseBase&&sparseOlder.hasMore,'loadOlder accepts a projected page whose tail is not baseSeq - 1');
  c.history=api.sessions.history;
  c.xhRestoreBaseSeq=51;
  for(const events of [[row(100),row(99)],[row(100),row(151)],[row(100),row(100)]]) {
    let failed=false;c.history=async()=>({result:{ok:true,value:{events,hasMore:false}}});
    try{await c.restoreHistoryRange(sparsePageOf(),c.openGeneration)}catch(error){failed=/invalid projected page/.test(String(error))}
    ok(failed,'reordered, overlapping, and duplicate projected pages are rejected');
  }
  c.history=api.sessions.history;c.xhRestoreBaseSeq=undefined;
  // The server losing the requested range must show an error, not fabricate success.
  c.xhRestoreBaseSeq=1;
  for(const value of [{events:[],hasMore:false},{events:[row(190)],hasMore:false}]) {
    let failed=false;try{await c.restoreHistoryRange(value,c.openGeneration)}catch{failed=true}
    ok(failed,'missing saved range is explicit');
  }
  c.xhRestoreBaseSeq=undefined;
  select('c');await c.open();
  // Pending send is protected even before running/queue feedback arrives.
  let finishCommand;remote.commands.execute=()=>new Promise(r=>{finishCommand=r});
  const command=c.command('fixture');select('e');manager.historyCacheStats();
  ok(c.openState==='open','pending command protected');finishCommand({ok:true});await command;await tick();
  ok(c.openState==='cold','settled command allows eviction');
  select('c');await c.open();
  // Epoch race: stale loadOlder must not prepend into a new window.
  c.hasMore=true;let olderRelease;c.history=()=>new Promise(r=>{olderRelease=r});const older=c.loadOlder();await tick();c.openGeneration++;c.installWindow(pageOf().events,true);olderRelease({result:{ok:true,value:pageOf(151)}});await older;
  ok(c.baseSeq===151,'old generation page ignored');
  // Same for initial history; model/context/host histories never touched by eviction.
  const z=select('z');let openRelease;z.history=()=>new Promise(r=>{openRelease=r});const stale=z.open();await tick();z.openGeneration++;z.openState='cold';openRelease({result:{ok:true,value:pageOf()}});await stale;ok(z.events.length===0,'stale open ignored');
  manager.drop('z');ok(!manager.xhHistoryCache.entries.has('z')&&z.xhHistoryOwner===undefined,'scope drop cleans manager entry');
  window.makeMemoryFixture=async(enabled)=>{
    window.memoryManager=null;await tick();
    const m=new SessionManager(api,remote,undefined,undefined,conversation);window.memoryManager=m;
    for(let n=0;n<32;n++){
      const id='memory-'+n;m.summaries.push({sessionId:id,running:false,blank:false,updatedAt:0});m.select(id);const s=m.get(id);
      if(!enabled)m.xhHistoryCache.limits={maxInactiveSessions:1000,maxInactiveBytes:1e12};
      // Independently allocated wire-like strings. No fixture array retains them.
      const entries=Array.from({length:160},(_,i)=>({event:{seq:i+1,time:i,type:'fixture/text',data:{text:Array.from({length:2048},(_,j)=>String.fromCharCode(33+(n+i+j)%90)).join('')}},view:{summary:'tool '+i}}));
      s.installWindow(entries,false);s.openState='open';s.getSnapshot();await tick();
    }
    await tick();return m.historyCacheStats();
  };
  return checks;
 });
 await page.evaluate(()=>atomicFixture());
 assert.equal(await page.locator('[data-retained-message]').count(),1,'old message remains visible after real compaction mapping failure');
 await page.waitForSelector('[role="alert"]');
 assert.match(await page.locator('[role="alert"]').innerText(),/chat.loadError/);
 if(process.env.UI_TEST_SCREENSHOT) await page.screenshot({path:process.env.UI_TEST_SCREENSHOT});
 await page.locator('[data-history-retry]').click();
 await page.waitForFunction(()=>atomicState().state==='open');
 assert.equal(await page.locator('[role="alert"]').count(),0);
 assert.equal(await page.locator('[data-retained-message]').count(),1);
 assert.deepEqual(await page.evaluate(()=>atomicState()),{calls:3,state:'open',events:1});
 await page.evaluate(()=>atomicUnmount());
 const cdp=engine==='chromium'?await page.context().newCDPSession(page):null;
 async function heap(){if(!cdp)return null;await cdp.send('HeapProfiler.collectGarbage');return (await cdp.send('Runtime.getHeapUsage')).usedSize;}
 const baselineStats=await page.evaluate(()=>makeMemoryFixture(false));const baseline=await heap();
 const boundedStats=await page.evaluate(()=>makeMemoryFixture(true));const bounded=await heap();
 assert.equal(baselineStats.inactiveSessions,31);assert.equal(boundedStats.inactiveSessions,6);
 if(cdp){assert.ok(bounded<baseline*.7,JSON.stringify({baseline,bounded}));assert.equal(await page.evaluate(()=>oldEvents.deref()===undefined&&oldEvent.deref()===undefined),true,'evicted raw history and event objects are GC-reclaimable');}
 assert.deepEqual(errors.filter(e=>!e.includes('fixture stop boot')),[]);
 console.log(JSON.stringify({engine,checks,atomicHistory:'real compaction mapping failure retains ChatView; retry succeeds with history RPC only',baselineHeapBytes:baseline,boundedHeapBytes:bounded,baselineStats,boundedStats,note:'32 synthetic sessions x 160 events; payload estimates are not process RSS'}));
}finally{await browser.close()}
