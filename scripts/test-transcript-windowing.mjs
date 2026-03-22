import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { patchTranscriptWindowing } from './patch-transcript-windowing.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'ui/dist');
const shipped = readFileSync(resolve(dist,'plugins/@deepseek-ai/dsh-client-ui-conversation/client.js'));
new Script(shipped.toString());
assert.deepEqual(patchTranscriptWindowing(shipped), shipped);
assert.deepEqual(patchTranscriptWindowing(Buffer.from(shipped.toString().replace("Product-owned transcript DOM", "Older transcript DOM"))), shipped);
assert.throws(()=>patchTranscriptWindowing(Buffer.from('upstream changed')), /anchor changed/);
const graph=JSON.parse(readFileSync(resolve(dist,'client-graph.json')));
const entry=graph.entries.find(e=>e.id==='@deepseek-ai/dsh-client-ui-conversation');
assert.equal(entry.rev,createHash('sha256').update(shipped).digest('hex').slice(0,16));
assert.ok(readFileSync(resolve(dist,'index.html'),'utf8').includes(entry.url));
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'));
const engine=process.env.UI_TEST_BROWSER??'chromium';
const browser=await require('playwright')[engine].launch({headless:true});
const helper=readFileSync(resolve(root,'ui/overrides/transcript-windowing.js'),'utf8');
assert.ok(shipped.toString().includes(helper), 'shipped implementation must match maintained source');
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const assets=readdirSync(resolve(dist,'assets'));
 const index=readFileSync(resolve(dist,'index.html'),'utf8').match(/src="\/assets\/(index-[^"?]+\.js)/)[1];
 await page.route('**/*',route=>{
  const url=new URL(route.request().url()), name=url.pathname.slice('/assets/'.length);
  if(url.pathname.startsWith('/assets/')&&assets.includes(name))return route.fulfill({body:readFileSync(resolve(dist,'assets',name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<script>window.__ModuleLoader__={create:o=>{window.staticModules=o.staticModules;throw Error('fixture stop boot')}};</script><script type="module" src="/assets/${index}"></script><style>.fixture-row:empty{display:none}</style><div id="root"></div>`});
  return route.abort();
 });
 await page.goto('http://transcript.test/');await page.waitForFunction(()=>window.staticModules);
 await page.addScriptTag({content:helper});
 await page.evaluate(()=>{
  const R=staticModules.react,D=staticModules['react-dom'],WindowRow=createTranscriptWindowing(R);
  const root=D.createRoot(document.getElementById('root'));window.fixtureRoot=root;
  window.rows=Array.from({length:350},(_,i)=>({id:String(i),lines:Array.from({length:40},(_,j)=>`row ${i} line ${j} const value = ${i+j}; `+'content '.repeat(12))}));
  window.active=false;window.virtual=false;
  function Heavy({row}){const [expanded,setExpanded]=R.useState(false);return R.createElement('section',{},R.createElement('button',{onClick:()=>setExpanded(v=>!v)},expanded?'Collapse':'Expand'),expanded&&R.createElement('div',{'data-expanded':row.id},'saved expansion'),R.createElement('pre',{style:{margin:0,whiteSpace:'pre-wrap'}},row.lines.map((line,i)=>R.createElement('span',{key:i,style:{display:'block'}},line))))}
  window.render=()=>D.flushSync(()=>root.render(R.createElement('div',{'data-conversation-scroll':'',style:{height:600,width:'900px',overflow:'auto',overflowAnchor:'none'}},rows.map(row=>R.createElement(virtual?WindowRow:'div',{key:row.id,'data-row':row.id,className:'fixture-row',...(virtual?{keepMounted:active&&row.id===rows.at(-1).id}:{})},R.createElement(Heavy,{row}))))));
  render();
 });
 const scroll=page.locator('[data-conversation-scroll]');
 const cdp=engine==='chromium'?await page.context().newCDPSession(page):null;
 async function metrics(){if(!cdp)return {dom:await page.locator('*').count()};await cdp.send('HeapProfiler.collectGarbage');const dom=await cdp.send('Memory.getDOMCounters');const heap=await cdp.send('Runtime.getHeapUsage');return {dom:dom.nodes,heapBytes:heap.usedSize};}
 const baseline=await metrics();
 await page.evaluate(()=>{virtual=true;render()});
 await page.waitForFunction(()=>document.querySelectorAll('[data-transcript-mounted="false"]').length>300);
 const optimized=await metrics();
 assert.ok(optimized.dom<baseline.dom*.35,JSON.stringify({baseline,optimized}));
 // Eviction preserves scroll extent; exact initial measurements, not estimates.
 const initialHeight=await scroll.evaluate(e=>e.scrollHeight);
 await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});
 await page.locator('[data-row="349"] button').waitFor();
 await page.waitForTimeout(100);
 assert.equal(await scroll.evaluate(e=>e.scrollHeight),initialHeight);
 // Interaction pins local upstream state even when the row leaves the window.
 await page.locator('[data-row="349"] button').click();
 await scroll.evaluate(e=>{e.scrollTop=0});
 await page.locator('[data-row="0"] button').waitFor();
 assert.equal(await page.locator('[data-expanded="349"]').count(),1);
 // Active suffix remains mounted even when offscreen; settling allows eviction.
 await page.evaluate(()=>{active=true;rows.push({id:'350',lines:['streaming']});render()});
 await page.locator('[data-row="350"] button').waitFor({state:'attached'});
 await page.evaluate(()=>{active=false;render()});
 await page.waitForFunction(()=>document.querySelector('[data-row="350"]').dataset.transcriptMounted==='false');
 // Width changes remount and remeasure rather than retaining stale wrapped sizes.
 await scroll.evaluate(e=>{e.style.width='420px'});
 await page.waitForTimeout(350);
 assert.ok(await scroll.evaluate(e=>e.scrollHeight)>initialHeight);
 await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});
 await page.locator('[data-row="350"] button').waitFor();
 // Session unmount cleans observers; mounting a new conversation is still functional.
 await page.evaluate(()=>{rows=rows.slice(0,20);render()});
 await scroll.evaluate(e=>{e.scrollTop=0});
 await page.locator('[data-row="0"] button').waitFor();
 // Exercise the actual shipped ChatView, not only the windowing primitive.
 await page.evaluate(()=>{fixtureRoot.unmount();window.registrations={};window.__ModuleLoader__={load:r=>{registrations[r.id]=r}}});
 for(const name of readdirSync(resolve(dist,'plugins/@deepseek-ai'))) {
  let source=readFileSync(resolve(dist,'plugins/@deepseek-ai',name,'client.js'),'utf8');
  if(name==='dsh-client-ui-conversation')source=source.replace('exports.apply = apply;', 'exports.ChatView = ChatView; exports.apply = apply;');
  await page.addScriptTag({content:source});
 }
 await page.evaluate(()=>{
  const cache={};function load(id){if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;return cache[name]??(cache[name]=registrations[name].factory(load))}
  const R=staticModules.react,D=staticModules['react-dom'],View=load('@deepseek-ai/dsh-client-ui-conversation/client').ChatView;
  const root=D.createRoot(document.getElementById('root'));window.fixtureRoot=root;
  const make=i=>({key:String(i),kind:'user',anchorSeq:i,data:{}});
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
 assert.ok(await scroll.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)<30,'actual ChatView opens at bottom');
 await scroll.evaluate(e=>{e.scrollTop=5000});await page.waitForTimeout(150);
 const before=await scroll.evaluate(e=>e.scrollTop);
 await page.evaluate(()=>{snap={...snap,chat:{...snap.chat,order:[...snap.chat.order,'100'],nodes:new Map([...snap.chat.nodes,['100',{key:'100',kind:'assistant',anchorSeq:100,data:{}}]])}};renderActual()});
 await page.waitForTimeout(150);
 assert.ok(Math.abs(await scroll.evaluate(e=>e.scrollTop)-before)<2,'append does not pull history reader to bottom');
 // Invoke the real load-older button; offscreen anchors remain in the DOM.
 const anchor=await page.evaluate(()=>{const root=document.querySelector('[data-conversation-scroll]'),top=root.getBoundingClientRect().top;const row=[...root.querySelectorAll('[data-chat-anchor-key]')].find(e=>e.getBoundingClientRect().top>=top);return {key:row.dataset.chatAnchorKey,top:row.getBoundingClientRect().top}});
 await page.getByRole('button',{name:'chat.loadOlder',exact:true}).dispatchEvent('click');
 await page.waitForTimeout(200);
 const after=await page.locator('[data-chat-anchor-key="'+anchor.key+'"]').evaluate(e=>e.getBoundingClientRect().top);
 assert.ok(Math.abs(after-anchor.top)<2,'prepend preserves real ChatView anchor');
 await page.evaluate(()=>fixtureRoot.unmount());
 assert.deepEqual(errors.filter(e=>!e.includes('fixture stop boot')),[]);
 console.log(JSON.stringify({engine,baseline,optimized,checks:'extent, offscreen eviction, interaction state, active row, resize, cleanup, shipped ChatView bottom/append/prepend anchors',note:'synthetic 350-row fixture; JS heap/DOM only, not macOS physical footprint'}));
} finally {await browser.close()}
