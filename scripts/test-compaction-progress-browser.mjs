// Shipped React, component, locale strings and CSS; isolated fixture, no Host/model calls.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)), dist=resolve(root,'ui/dist');
const read=p=>readFileSync(resolve(root,p),'utf8');
const source=read('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js');
const helper=read('ui/overrides/compaction-progress.js');
assert.ok(source.includes(helper));
const hookStart=source.indexOf('function xhUseTranscriptState('),hookEnd=source.indexOf('\n}',hookStart)+2;
const hook=source.slice(hookStart,hookEnd);
const classes=source.match(/var MessageItem_module_css_default = \{([\s\S]*?)\};/)[0];
const css=[...source.matchAll(/const css(?:\$\d+)? = ("[^\n]+");/g)].map(m=>JSON.parse(m[1])).join('\n');
const dicts={zh:{},en:{}};
for(const match of source.matchAll(/"((?:xh\.compact\.|message\.compaction\.running)[^"\n]*)": ("(?:[^"\\]|\\.)*")/g)) {
  const text=JSON.parse(match[2]);dicts[/[\u3400-\u9fff]/.test(text)?'zh':'en'][match[1]]=text;
}
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'));
const engine=process.env.UI_TEST_BROWSER??'chromium';
const browser=await require('playwright')[engine].launch({headless:true});
const artifacts=process.env.UI_TEST_ARTIFACTS;
if(artifacts) mkdirSync(artifacts,{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:1000,height:720}});
 const errors=[];page.on('pageerror',e=>{if(e.message!=='fixture stop boot')errors.push(e.message)});
 const assets=readdirSync(resolve(dist,'assets'));
 const index=read('ui/dist/index.html').match(/src="\/assets\/(index-[^"?]+\.js)/)[1];
 await page.route('**/*',route=>{
  const url=new URL(route.request().url()),name=url.pathname.slice('/assets/'.length);
  if(url.pathname.startsWith('/assets/')&&assets.includes(name)) return route.fulfill({body:readFileSync(resolve(dist,'assets',name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script>window.__ModuleLoader__={create:o=>{window.staticModules=o.staticModules;throw Error('fixture stop boot')}};</script><script type="module" src="/assets/${index}"></script><style>${css}\nbody{font:14px system-ui;margin:0;background:#fff;color:#171717;--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#717171;--dsw-alias-line-secondary:#e5e5e5}main{max-width:760px;margin:80px auto;padding:24px}button{color:inherit;font:inherit}</style></head><body><main><h2>Context compaction</h2><p>Isolated UI regression · no model requests</p><div id="root"></div></main></body></html>`});
  return route.abort();
 });
 await page.goto('http://compaction.test/');await page.waitForFunction(()=>window.staticModules);
 await page.evaluate(({helper,hook,classes,dicts})=>{
  const react=staticModules.react, react_jsx_runtime=staticModules['react/jsx-runtime'],D=staticModules['react-dom'];
  const primitive=()=>react.createElement('span',{'aria-hidden':true},'◇');
  const primitives={IconApiOutline14:primitive,IconChevronDownOutline14:primitive,IconChevronRightOutline14:primitive};
  window.Card=Function('react','react_jsx_runtime','_xharness_dsh_client_ui_primitives',hook+'\n'+classes+'\n'+helper+'\nreturn XhCompactionProgressCard;')(react,react_jsx_runtime,primitives);
  const root=D.createRoot(document.getElementById('root'));
  const nativeSet=setInterval,nativeClear=clearInterval, timers=new Set();
  window.setInterval=(...args)=>{const id=nativeSet(...args);timers.add(id);return id;};
  window.clearInterval=id=>{timers.delete(id);nativeClear(id);};window.timerCount=()=>timers.size;
  window.render=(data,locale='zh',key='a')=>D.flushSync(()=>root.render(data ? react.createElement(Card,{data,t:(key,args={})=>{
    let text=dicts[locale][key]??key;for(const [name,value] of Object.entries(args)) text=text.replaceAll('{'+name+'}',String(value));return text;
  },key}) : null));
  window.running={status:'running',seq:10,time:Date.now()-154000,progressTime:Date.now(),progress:{stage:'retrying',calls:3,completedParts:1,splits:1,retries:2,delayMs:5000,inputTokensBefore:180000}};
  render(running);
 },{helper,hook,classes,dicts});
 await page.waitForFunction(()=>timerCount()===1);
 const card=page.locator('[data-compaction-progress]');
 assert.equal(await card.locator('button').getAttribute('aria-expanded'),'false');
 const bar=card.getByRole('progressbar');
 assert.equal(await bar.count(),1);
 assert.equal(await bar.getAttribute('aria-valuenow'),null,'unknown total is indeterminate, not a fabricated percentage');
 assert.ok((await card.innerText()).includes('第 2 次重试'),'retry countdown stays visible without expanded metrics');
 assert.ok(!(await card.innerText()).includes('3 次请求'),'statistics are collapsed by default');
 assert.ok((await card.innerText()).includes('等待网络恢复'));
 const clockSeconds=async()=>{
  const match=(await card.innerText()).match(/(\d+)m (\d{2})s/);
  assert.ok(match,'elapsed clock is visible');return Number(match[1])*60+Number(match[2]);
 };
 const initialClock=await clockSeconds();assert.ok(initialClock>=154);
 await card.locator('button').click();
 assert.ok((await card.innerText()).includes('第 2 次重试'));
 assert.ok((await card.innerText()).includes('3 次请求'));
 await page.waitForTimeout(1100);
 assert.ok(await clockSeconds()>initialClock,'elapsed clock advances without a provider event');
 await page.evaluate(()=>render({...running,progress:{...running.progress,stage:'merging',delayMs:undefined}}));
 assert.equal(await card.locator('button').getAttribute('aria-expanded'),'true','progress update preserves expansion');
 assert.equal(await card.locator('.xhCompactSweep').evaluate(e=>getComputedStyle(e).animationName),'xh-compact-sweep');
 await page.evaluate(()=>render({...running,progress:{...running.progress,stage:'paused',delayMs:undefined}}));
 assert.equal(await card.locator('.xhCompactSweep').evaluate(e=>getComputedStyle(e).animationPlayState),'paused');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await card.locator('.xhCompactSweep').evaluate(e=>getComputedStyle(e).animationName),'none','reduced motion disables the sweep');
 await page.emulateMedia({reducedMotion:'no-preference'});
 assert.equal(await page.locator('#xh-compaction-progress-style').count(),1,'style is injected once, not per update or row');
 await page.evaluate(()=>render(running,'en','session-b'));
 assert.equal(await card.locator('button').getAttribute('aria-expanded'),'false','session identity isolates expansion');
 assert.ok((await card.innerText()).includes('Waiting for network'));
 for(const theme of ['light','dark']) for(const width of [360,715,1440]) {
  await page.setViewportSize({width,height:720});
  await page.evaluate(theme=>{document.body.style.background=theme==='dark'?'#101010':'#fff';document.body.style.color=theme==='dark'?'#f5f5f5':'#171717';},theme);
  for(const locale of ['zh','en']) {
   await page.evaluate(locale=>render({...running,status:'failed',endedAt:running.time+154000,error:'network failed / '+ 'long-identifier-'.repeat(80)},locale,'failure-'+locale),locale);
   await card.locator('button').click();
   assert.ok(await card.locator('[role=alert]').count());
   assert.equal(await card.getByRole('progressbar').count(),0,'terminal errors must not keep showing a running bar');
   const size=await page.evaluate(()=>({full:document.documentElement.scrollWidth,window:innerWidth}));
   assert.ok(size.full<=size.window+1,JSON.stringify({theme,width,locale,size}));
  }
 }
 await page.setViewportSize({width:1000,height:720});
 await page.evaluate(()=>{document.body.style.background='#fff';document.body.style.color='#171717';render(running,'zh','preview');});
 await card.locator('button').click();
 if(artifacts) await page.screenshot({path:resolve(artifacts,`compaction-progress-${engine}.png`),fullPage:true});
 await page.evaluate(()=>render(null));await page.waitForFunction(()=>timerCount()===0);
 assert.deepEqual(errors,[]);
 console.log(`${engine}: compaction shipped React UI passed; live clock, countdown, expand, session isolation, 12 responsive locale/theme cases, visible failure, unmount timer cleanup; no Host/model calls`);
} finally {await browser.close();}
