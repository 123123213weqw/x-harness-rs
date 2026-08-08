import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs';
import {exposeModuleUnit} from './fixtures/module-unit-scope.mjs';
import assert from 'node:assert/strict';
import {verifyConversationArtifact,exposeConversation,legacyConversation} from './conversation-artifact-test.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { patchTranscriptWindowing } from './patch-transcript-windowing.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const implementation=process.env.UI_TEST_IMPL??'source';assert.ok(['source','legacy'].includes(implementation));
const dist = resolve(root, implementation==='source'?'ui/dist':'ui/reference/master-a613970');
const sourceArtifact=Buffer.from(verifyConversationArtifact()),golden=legacyConversation();
const shipped=implementation==='source'?sourceArtifact:golden;
new Script(shipped.toString());
assert.deepEqual(patchTranscriptWindowing(golden), golden);
assert.deepEqual(patchTranscriptWindowing(Buffer.from(golden.toString().replace("Product-owned bounded transcript DOM", "Older transcript DOM"))), golden);
assert.throws(()=>patchTranscriptWindowing(Buffer.from('upstream changed')), /anchor changed/);
const graph=JSON.parse(readFileSync(resolve(dist,'client-graph.json')));
const entry=graph.entries.find(e=>e.id==='@xharness/dsh-client-ui-conversation');
assert.equal(entry.rev,createHash('sha256').update(shipped).digest('hex').slice(0,16));
assert.ok(readFileSync(resolve(dist,'index.html'),'utf8').includes(entry.url));
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'));
const engine=process.env.UI_TEST_BROWSER??'chromium';
const browser=await require('playwright')[engine].launch({headless:true});
const helper=readFileSync(resolve(root,'ui/overrides/transcript-windowing.js'),'utf8');
assert.ok(golden.toString().includes(helper), 'shipped implementation must match maintained source');
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}});
 if (process.env.UI_TEST_NO_NATIVE_ANCHOR === '1') {
  assert.equal(implementation, 'source', 'unsupported anchor regression is not a frozen-baseline rewrite');
  await page.addInitScript(() => {
   const native = window.getComputedStyle;
   window.getComputedStyle = (...args) => new Proxy(native(...args), {
    get: (style, key) => {
     if (key === 'overflowAnchor') return undefined;
     const value = Reflect.get(style, key, style);
     return typeof value === 'function' ? value.bind(style) : value;
    },
   });
  });
 }
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await installOwnedViewPlatform(page,shipped.toString().startsWith('// Generated from src/modules/conversation/')?'source':'legacy');
 if (process.env.UI_TEST_NO_NATIVE_ANCHOR === '1') assert.equal(
  await page.evaluate(() => getComputedStyle(document.body).overflowAnchor === undefined), true,
  'the unsupported-property branch must actually be exercised',
 );
 await page.addStyleTag({content:'.fixture-row:empty{display:none}'});
 await page.evaluate(()=>{window.registrations={};window.__ModuleLoader__={load:r=>{registrations[r.id]=r}}});
 for(const name of readdirSync(resolve(dist,'plugins/@xharness'))) {
  let source=readFileSync(resolve(dist,'plugins/@xharness',name,'client.js'),'utf8');
  if(name==='dsh-client-ui-conversation')source=exposeConversation(shipped.toString(),['XhTranscriptWindowRow','ChatView','createTranscriptWindowing']);
  await page.addScriptTag({content:source});
 }
 await page.evaluate(()=>{const cache={};window.loadFixture=id=>{if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;return cache[name]??(cache[name]=registrations[name].factory(loadFixture))}});
 await page.evaluate(()=>{
  const R=staticModules.react,D=staticModules['react-dom'];
  const createTranscriptWindowing=loadFixture('@xharness/dsh-client-ui-conversation/client').createTranscriptWindowing;
  const WindowRow=createTranscriptWindowing(R);
  const identity=globalThis.__xhTranscriptState.get(R.createElement);createTranscriptWindowing({...R});
  if(identity!==globalThis.__xhTranscriptState.get(R.createElement))throw Error('React namespace wrappers must share row state');
  const root=D.createRoot(document.getElementById('root'));window.fixtureRoot=root;
  window.rows=Array.from({length:350},(_,i)=>({id:String(i),lines:Array.from({length:40},(_,j)=>`row ${i} line ${j} const value = ${i+j}; `+'content '.repeat(12))}));
  window.active=false;window.virtual=false;
  function Heavy({row}){const [expanded,setExpanded]=globalThis.__xhTranscriptState.get(R.createElement).useState("fixture-expanded",false);return R.createElement('section',{},R.createElement('button',{onClick:()=>setExpanded(v=>!v)},expanded?'Collapse':'Expand'),expanded&&R.createElement('div',{'data-expanded':row.id},'saved expansion'),R.createElement('pre',{style:{margin:0,whiteSpace:'pre-wrap'}},row.lines.map((line,i)=>R.createElement('span',{key:i,style:{display:'block'}},line))))}
  window.render=()=>D.flushSync(()=>root.render(R.createElement('div',{'data-conversation-scroll':'',style:{height:600,width:'900px',overflow:'auto',overflowAnchor:'none'}},rows.map(row=>R.createElement(virtual?WindowRow:'div',{key:row.id,'data-row':row.id,className:'fixture-row',...(virtual?{keepMounted:active&&row.id===rows.at(-1).id}:{})},R.createElement(Heavy,{row}))))));
  render();
 });
 const scroll=page.locator('[data-conversation-scroll]');
 const cdp=engine==='chromium'?await page.context().newCDPSession(page):null;
 async function metrics(){if(!cdp)return {dom:await page.locator('*').count()};await cdp.send('HeapProfiler.collectGarbage');const dom=await cdp.send('Memory.getDOMCounters');const heap=await cdp.send('Runtime.getHeapUsage');return {dom:dom.nodes,heapBytes:heap.usedSize};}
 const baseline=await metrics();
 // The controller's frame must COMMIT its bounded row plan, not merely queue
 // React state. A native wheel can arrive before a deferred commit shrinks
 // the range. Observe the DOM after the controller's RAF in that same frame;
 // this contract fails deterministically with asynchronous row publication.
 if(implementation==='source')await page.evaluate(()=>{
  const NativeIntersectionObserver=window.IntersectionObserver;
  window.windowingFrames=[];window.recordWindowingFrames=true;
  window.IntersectionObserver=class extends NativeIntersectionObserver{
   constructor(callback,options){super((entries,observer)=>{
    callback(entries,observer);
    const visible=entries.filter(entry=>entry.isIntersecting&&entry.target.hasAttribute('data-transcript-mounted'));
    if(!window.recordWindowingFrames||!visible.length)return;
    requestAnimationFrame(()=>{
     window.windowingFrames.push(visible.map(entry=>({id:entry.target.dataset.row,mounted:entry.target.dataset.transcriptMounted})));
    });
   },options)}
  };
  window.restoreIntersectionObserver=()=>{window.recordWindowingFrames=false;window.IntersectionObserver=NativeIntersectionObserver};
 });
 const firstWindowed = await page.evaluate(()=>{virtual=true;render();return document.querySelectorAll("[data-transcript-mounted=true]").length});
 assert.equal(firstWindowed,0,"first windowed commit never mounts full history");
 if(implementation==='source'){
  await page.waitForFunction(()=>window.windowingFrames.length>0);
  const frameReceipt=await page.evaluate(()=>{restoreIntersectionObserver();return window.windowingFrames.flat()});
  assert.ok(frameReceipt.length>0);
  assert.ok(frameReceipt.every(row=>row.mounted==='true'),'near row DOM must match the controller plan before its frame ends: '+JSON.stringify(frameReceipt));
 }
 await page.waitForFunction(()=>document.querySelectorAll('[data-transcript-mounted="false"]').length>300);
 const optimized=await metrics();
 assert.ok(await page.locator('[data-row]').count()===350,'lightweight row keys and complete data remain');
 assert.ok(optimized.dom<baseline.dom*.35,JSON.stringify({baseline,optimized}));
 // Unmeasured seats preserve estimated extent; near rows progressively correct it.
 const initialHeight=await scroll.evaluate(e=>e.scrollHeight);
 await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});
 await page.locator('[data-row="349"] button').waitFor();
 await page.waitForTimeout(100);
 assert.ok(await scroll.evaluate(e=>e.scrollHeight)>80000,"unvisited history still has scroll extent");
 // Row-owned state survives eviction; current focus (source UI) is temporary, never a permanent interaction pin.
 await page.locator('[data-row="349"] button').click();
 if(implementation==='source')await page.locator('[data-row="349"] button').focus();
 await scroll.evaluate(e=>{e.scrollTop=0});
 await page.locator('[data-row="0"] button').waitFor();
 if(implementation==='source'){
  assert.equal(await page.locator('[data-row="349"] button').count(),1,'currently focused disclosure is protected');
  await page.locator('[data-row="0"] button').focus();
 }
 await page.waitForFunction(()=>document.querySelector('[data-row="349"]').dataset.transcriptMounted==='false');
 assert.equal(await page.locator('[data-expanded="349"]').count(),0);
 await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});
 await page.locator('[data-expanded="349"]').waitFor();
 await scroll.evaluate(e=>{e.scrollTop=0});
 await page.locator('[data-row="0"] button').waitFor();
 await page.evaluate(()=>document.activeElement.blur());
 // A genuine text selection is temporarily protected, then released.
 // Releasing focus can commit pending window measurements. An attached
 // button alone does not prove that the first row is the settled reader
 // viewport (especially on a two-CPU Linux WebKit runner).
 await scroll.evaluate(e=>{e.scrollTop=0});
 const selectedText=await page.evaluate(async()=>{
  const root=document.querySelector('[data-conversation-scroll]');
  let previous='',stable=0,text;
  for(let frame=0;frame<120;frame++){
   await new Promise(resolve=>requestAnimationFrame(resolve));
   const row=document.querySelector('[data-row="0"]'),span=row?.querySelector('pre span');
   const viewport=root.getBoundingClientRect(),bounds=row?.getBoundingClientRect();
   const ready=span?.firstChild&&root.scrollTop<1&&bounds.bottom>viewport.top&&bounds.top<viewport.bottom;
   const signature=JSON.stringify([root.scrollTop,root.scrollHeight,bounds?.top,bounds?.height]);
   stable=ready&&signature===previous?stable+1:0;previous=signature;
   if(stable>=3){text=span.firstChild;break}
  }
  if(!text)throw Error('first row did not settle in the selection viewport');
  const range=document.createRange();range.selectNodeContents(text);
  const selection=document.getSelection();
  await new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);document.removeEventListener('selectionchange',changed)};
   const changed=()=>{if(selection.isCollapsed||selection.toString()!==text.textContent)return;cleanup();resolve()};
   const timer=setTimeout(()=>{cleanup();reject(Error('native selectionchange was not delivered'))},3000);
   document.addEventListener('selectionchange',changed);
   selection.removeAllRanges();selection.addRange(range);
  });
  // Wait for native selection delivery, not an arbitrary Node-side sleep.
  // Check the real selection again before asking the row to leave view.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(selection.isCollapsed||!range.intersectsNode(document.querySelector('[data-row="0"]')))
   throw Error('fixture did not establish a genuine first-row selection');
  return selection.toString();
 });
 assert.ok(selectedText.length>0,'selection fixture must select real text');
 await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});await page.waitForTimeout(100);
 assert.equal(await page.locator('[data-row="0"] button').count(),1,'selected text is not evicted');
 assert.equal(await page.evaluate(()=>document.getSelection().toString()),selectedText,'selected text stays intact after leaving the viewport');
 await page.evaluate(()=>document.getSelection().removeAllRanges());
 await page.waitForFunction(()=>document.querySelector('[data-row="0"]').dataset.transcriptMounted==='false');
 await scroll.evaluate(e=>{e.scrollTop=0});await page.locator('[data-row="0"] button').waitFor();
 // The live tip remains mounted even when offscreen; settling allows eviction.
 await page.evaluate(()=>{active=true;rows.push({id:'350',lines:['streaming']});render()});
 await page.locator('[data-row="350"] button').waitFor({state:'attached'});
 await page.evaluate(()=>{active=false;render()});
 await page.waitForFunction(()=>document.querySelector('[data-row="350"]').dataset.transcriptMounted==='false');
 // Width changes must never remount all offscreen messages.
 await page.evaluate(()=>{
  window.resizePeak=document.querySelectorAll('[data-transcript-mounted=true]').length;
  window.resizeObserver=new MutationObserver(()=>{resizePeak=Math.max(resizePeak,document.querySelectorAll('[data-transcript-mounted=true]').length)});
  resizeObserver.observe(document.getElementById('root'),{childList:true,subtree:true});
 });
 await scroll.evaluate(e=>{e.style.width='420px'});
 for (const width of [900,420,760,380,900]) { await scroll.evaluate((e,width)=>{e.style.width=width+'px'},width); await page.waitForTimeout(100); }
 await page.waitForTimeout(350);
 assert.ok(await page.evaluate(()=>resizePeak)<25,"resize peak is bounded");
 const resizePeak=await page.evaluate(()=>{resizeObserver.disconnect();return window.resizePeak});
 await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});
 await page.locator('[data-row="350"] button').waitFor();
 // Session unmount cleans observers; mounting a new conversation is still functional.
 await page.evaluate(()=>{rows=rows.slice(0,20);render()});
 await scroll.evaluate(e=>{e.scrollTop=0});
 await page.locator('[data-row="0"] button').waitFor();
 // Exercise the actual shipped ChatView, not only the windowing primitive.
 await page.evaluate(()=>{fixtureRoot.unmount();window.registrations={};window.__ModuleLoader__={load:r=>{registrations[r.id]=r}}});
 for(const name of readdirSync(resolve(dist,'plugins/@xharness'))) {
  let source=readFileSync(resolve(dist,'plugins/@xharness',name,'client.js'),'utf8');
  if(name==='dsh-client-ui-conversation')source=exposeConversation(shipped.toString(),['ChatView','ReasoningRow','CompactionItem','createTranscriptWindowing']);
  if(name==='dsh-client-ui-tool')source=exposeModuleUnit(source,'tool','tool/components/ToolRow','ToolRow');
  if(name==='dsh-client-ui-cordis')source=exposeModuleUnit(source,'cordis','CordisDefineRow','CordisDefineRow');
  await page.addScriptTag({content:source});
 }
 await page.evaluate(()=>{
  const cache={};function load(id){if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;return cache[name]??(cache[name]=registrations[name].factory(load))}
  const R=staticModules.react,D=staticModules['react-dom'],Row=load('@xharness/dsh-client-ui-conversation').createTranscriptWindowing(R);
  const {ToolRow}=load('@xharness/dsh-client-ui-tool');
  const {CordisDefineRow}=load('@xharness/dsh-client-ui-cordis');
  const {ReasoningRow,CompactionItem}=load('@xharness/dsh-client-ui-conversation');
  const root=D.createRoot(document.getElementById('root'));window.fixtureRoot=root;
  const api=globalThis.__xhTranscriptState.get(R.createElement);
  document.documentElement.dataset.xhProcessMode='compact';
  function Editable(){const [value,set]=api.useState('draft','');return R.createElement('input',{'data-draft':'',value,onChange:e=>set(e.target.value)})}
  const children=()=>R.createElement('section',{},
    ...['one','two'].map(stateKey=>R.createElement('div',{'data-tool':stateKey,key:stateKey},R.createElement(ToolRow,{stateKey,t:k=>k,variant:'bash',toolName:'bash',icon:null,title:stateKey,summary:'echo '+stateKey,summarySuffix:null,body:'command',output:'output',errorSummary:null,state:'ok'}))),
    R.createElement('div',{'data-reasoning':''},R.createElement(ReasoningRow,{stateKey:0,text:'reasoning content',running:false,t:k=>k})),
    R.createElement('div',{'data-compact':''},R.createElement(CompactionItem,{node:{status:'ended',summary:'saved compact summary',shadowedItemCount:1,shadowedTokenCount:128},t:k=>k})),
    R.createElement('details',{'data-native-detail':''},R.createElement('summary',{},'native detail'),R.createElement('p',{},'body')),
    ...['alpha','beta'].map(callId=>R.createElement('div',{'data-cordis':callId,key:callId},
      R.createElement(CordisDefineRow,{callId,
        block:{kind:'result',callId,content:[],subCalls:[],call:{argsRaw:JSON.stringify({name:callId,code:{client:'client code '+callId,host:'host code '+callId}})}},
        t:k=>k,useInventory:f=>f({rows:[],removed:new Set()}),useLoaded:f=>f({})}))),
    R.createElement(Editable));
  window.renderState=()=>D.flushSync(()=>root.render(R.createElement('div',{'data-conversation-scroll':'',style:{height:600,width:900,overflow:'auto',overflowAnchor:'none'}},
    R.createElement(Row,{'data-state-row':'',estimatedHeight:300},children()),
    R.createElement('div',{style:{height:15000}},'padding'))));renderState();
 });
 await page.locator('[data-tool="one"] [aria-expanded]').waitFor();
 await page.locator('[data-tool="one"] [aria-expanded]').click();
 await page.locator('[data-reasoning] [aria-expanded]').click();
 await page.locator('[data-native-detail] summary').click();
 await page.locator('[data-compact] button[aria-expanded]').click();
 await page.locator('[data-cordis=alpha] [aria-expanded]').click();
 await page.locator('[data-cordis=alpha]').getByRole('tab',{name:'body.hostCode',exact:true}).click();
 assert.equal(await page.locator('[data-cordis=beta] [aria-expanded=false]').count(),1);
 await page.locator('[data-draft]').fill('retain draft');
 // Focused text entry is temporarily protected, not every clicked button.
 await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});await page.waitForTimeout(150);
 assert.equal(await page.locator('[data-draft]').count(),1,'focused input is not evicted');
 await page.evaluate(()=>document.activeElement.blur());
 await page.waitForFunction(()=>document.querySelector('[data-state-row]').dataset.transcriptMounted==='false');
 await scroll.evaluate(e=>{e.scrollTop=0});
 await page.locator('[data-tool="one"] [aria-expanded=true]').waitFor();
 assert.equal(await page.locator('[data-tool="two"] [aria-expanded=false]').count(),1,'tool call states stay independent');
 await page.locator('[data-reasoning] [aria-expanded=true]').waitFor();
 await page.locator('[data-compact] button[aria-expanded=true]').waitFor();
 assert.ok((await page.locator('[data-compact]').textContent()).includes('saved compact summary'),'compact summary survives eviction');
 assert.equal(await page.locator('[data-native-detail]').evaluate(e=>e.open),true,'native details state restored');
 assert.equal(await page.locator('[data-draft]').inputValue(),'retain draft','row-owned input draft restored');
 assert.equal(await page.locator('[data-cordis=alpha] [aria-expanded=true]').count(),1,'Cordis expansion is restored');
 assert.equal(await page.locator('[data-cordis=beta] [aria-expanded=false]').count(),1,'Cordis sibling must stay collapsed after eviction');
 assert.equal(await page.locator('[data-cordis=alpha]').getByRole('tab',{name:'body.hostCode',exact:true}).getAttribute('aria-selected'),'true','Cordis source selection is restored');
 await page.locator('[data-cordis=beta] [aria-expanded]').click();
 assert.equal(await page.locator('[data-cordis=beta]').getByRole('tab',{name:'body.clientCode',exact:true}).getAttribute('aria-selected'),'true','Cordis sibling source stays independent');
 // A second eviction also preserves different source tabs within the same seat.
 await page.evaluate(()=>document.activeElement.blur());
 await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});
 await page.waitForFunction(()=>document.querySelector('[data-state-row]').dataset.transcriptMounted==='false');
 await scroll.evaluate(e=>{e.scrollTop=0});
 await page.locator('[data-cordis=alpha] [aria-expanded=true]').waitFor();
 await page.locator('[data-cordis=beta] [aria-expanded=true]').waitFor();
 assert.equal(await page.locator('[data-cordis=alpha]').getByRole('tab',{name:'body.hostCode',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('[data-cordis=beta]').getByRole('tab',{name:'body.clientCode',exact:true}).getAttribute('aria-selected'),'true');
 // Compact preference must not overwrite manually expanded state on remount.
 await page.waitForTimeout(100);
 assert.equal(await page.locator('[data-tool="one"] [aria-expanded=true]').count(),1);
 await page.evaluate(()=>{fixtureRoot.unmount();delete document.documentElement.dataset.xhProcessMode});
 await page.evaluate(()=>{
  const cache={};function load(id){if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;return cache[name]??(cache[name]=registrations[name].factory(load))}
  const R=staticModules.react,D=staticModules['react-dom'],View=load('@xharness/dsh-client-ui-conversation/client').ChatView;
  const root=D.createRoot(document.getElementById('root'));window.fixtureRoot=root;
  // Publish genuine Chat target DTOs. A raw {} is an unknown surface in the
  // strict reader, not a user/assistant row with the fixture's 160px body.
  const make=i=>({key:String(i),kind:'user',anchorSeq:100+i,data:{kind:'user',seq:100+i,time:100+i,source:{kind:'user'},content:[{type:'text',text:'Message '+i}]}});
  window.makeAssistant=(key,seq)=>({key,kind:'assistant-step',anchorSeq:seq,data:{status:'settled',turn:0,step:0,time:seq,blocks:[{kind:'text',text:'Message '+key}]}});
  const nodes=new Map(Array.from({length:100},(_,i)=>[String(i),make(i)]));
  window.snap={chat:{order:[...nodes.keys()],nodes,timeline:{turns:new Map()}},queue:[],running:false,openState:'open',openError:null,hasMore:true,loadingOlder:false};
  window.saved=null;
  const props={sessionId:'fixture',useSession:f=>f(snap),useSessions:f=>f({byId:{fixture:{cwd:'/workspace'}}}),useStore:f=>f({}),t:k=>k,
    chatScroll:{read:()=>saved,save:p=>{saved=p}},fileMentions:[],openFile:async()=>{},loadImage:async()=>{},inspectCall:()=>{},forkAt:()=>{},editMessage:()=>{},
    renderSlot:(_slot,owner)=>R.createElement('div',{'data-body':owner.node.key,style:{height:160}},'Message '+owner.node.key),
    loadOlder:()=>{for(let i=-20;i<0;i++)nodes.set(String(i),make(i));snap={...snap,chat:{...snap.chat,order:[...Array.from({length:20},(_,i)=>String(i-20)),...snap.chat.order]}};renderActual()}
  };
  window.renderActual=()=>D.flushSync(()=>root.render(R.createElement('div',{'data-conversation-scroll':'',style:{height:600,width:900,overflow:'auto','--dsh-chat-content-width':'100%','--dsh-composer-side-clearance':'0px',overflowAnchor:'none'}},R.createElement(View,props))));renderActual();
 });
 await page.waitForFunction(()=>document.querySelectorAll('[data-transcript-mounted="false"]').length>70);
 await page.locator('[data-body="99"]').waitFor();
 assert.ok(await scroll.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)<30,'actual ChatView opens at bottom');
 // Compaction replaces a large history span while the turn keeps running.
 // Native anchoring can emit a scroll without any reader gesture. That must
 // not turn off follow mode and strand the viewport at the compact marker.
 await page.evaluate(()=>{
  snap={...snap,running:true,chat:{...snap.chat,
    order:[...snap.chat.order.slice(-25),'compact'],
    nodes:new Map([...snap.chat.nodes,['compact',{key:'compact',kind:'compaction',anchorSeq:200,data:{kind:'compaction',seq:200,time:200,status:'running',error:null}}]])}};
  renderActual();
 });
 await scroll.evaluate(e=>{
  e.scrollTop=Math.max(0,e.scrollTop-120);
  e.dispatchEvent(new Event('scroll'));
 });
 await page.waitForTimeout(100);
 assert.ok(await scroll.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)<30,'compaction reflow keeps live follow');
 await page.evaluate(()=>{
  snap={...snap,chat:{...snap.chat,order:[...snap.chat.order,'after-compact'],
    nodes:new Map([...snap.chat.nodes,['after-compact',makeAssistant('after-compact',201)]])}};
  renderActual();
 });
 assert.ok(await scroll.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)<30,'answer after compact remains visible');
 await scroll.evaluate(e=>{
  e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-180}));
  e.scrollTop=Math.max(0,e.scrollTop-180);
  e.dispatchEvent(new Event('scroll'));
 });
 await page.waitForTimeout(40);
 const readerTop=await scroll.evaluate(e=>e.scrollTop);
 await page.evaluate(()=>{
  snap={...snap,chat:{...snap.chat,order:[...snap.chat.order,'after-reader-scroll'],
    nodes:new Map([...snap.chat.nodes,['after-reader-scroll',makeAssistant('after-reader-scroll',202)]])}};
  renderActual();
 });
 assert.ok(Math.abs(await scroll.evaluate(e=>e.scrollTop)-readerTop)<2,'explicit reader scroll disables follow');
 await page.evaluate(()=>{
  snap={...snap,running:false,chat:{...snap.chat,order:[...Array.from({length:100},(_,i)=>String(i))]}};renderActual();
 });
 // This is a fresh reader gesture, not an unrelated programmatic position
 // write after the previous phase's 1.5s attribution window has elapsed.
 await scroll.evaluate(e=>{e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-5000}));e.scrollTop=5000;e.dispatchEvent(new Event('scroll'))});await page.waitForTimeout(150);
 assert.equal(await page.getByRole('button',{name:'chat.toBottom',exact:true}).count(),1,'genuine history reader owns the viewport before append');
 const before=await scroll.evaluate(e=>e.scrollTop);
 await page.evaluate(()=>{snap={...snap,chat:{...snap.chat,order:[...snap.chat.order,'100'],nodes:new Map([...snap.chat.nodes,['100',makeAssistant('100',203)]])}};renderActual()});
 await page.waitForTimeout(150);
 const afterAppend=await scroll.evaluate(e=>e.scrollTop);
 if(Math.abs(afterAppend-before)>=2)console.error(JSON.stringify({implementation,engine,readerAppend:{before,after:afterAppend,geometry:await scroll.evaluate(e=>({floor:e.scrollHeight-e.clientHeight,rows:[...e.querySelectorAll('[data-transcript-mounted=true]')].map(row=>({key:row.dataset.chatAnchorKey,top:row.getBoundingClientRect().top,height:row.getBoundingClientRect().height})),saved:window.saved}))}}));
 assert.ok(Math.abs(afterAppend-before)<2,'append does not pull history reader to bottom');
 // Invoke the real load-older button; offscreen anchors remain in the DOM.
 const anchor=await page.evaluate(()=>{const root=document.querySelector('[data-conversation-scroll]'),top=root.getBoundingClientRect().top;const row=[...root.querySelectorAll('[data-chat-anchor-key]')].find(e=>e.getBoundingClientRect().top>=top);return {key:row.dataset.chatAnchorKey,top:row.getBoundingClientRect().top}});
 await page.getByRole('button',{name:'chat.loadOlder',exact:true}).dispatchEvent('click');
 await page.waitForTimeout(200);
 const after=await page.locator('[data-chat-anchor-key="'+anchor.key+'"]').evaluate(e=>e.getBoundingClientRect().top);
 assert.ok(Math.abs(after-anchor.top)<2,'prepend preserves real ChatView anchor');
 await page.evaluate(()=>fixtureRoot.unmount());
 assert.deepEqual(errors.filter(e=>e!=='owned feature fixture: stop Host boot'),[]);
 console.log(JSON.stringify({engine,implementation,noNativeAnchor:process.env.UI_TEST_NO_NATIVE_ANCHOR==='1',baseline,optimized,firstWindowed, resizePeak, checks:'bounded first mount/resize, tool/reasoning/native-details/draft state, call isolation, focus/selection protection and release, live tip, cleanup, real ChatView anchors',note:'synthetic 350-row fixture; JS heap/DOM only, not macOS physical footprint'}));
} finally {await browser.close()}
