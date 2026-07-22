// Shipped React, component, locale strings and CSS; isolated fixture, no Host/model calls.
import assert from 'node:assert/strict';
import {verifyConversationArtifact,exposeConversation,legacyConversation} from './conversation-artifact-test.mjs';
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs';
import {readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const implementation=process.env.UI_TEST_IMPL??'source';assert.ok(['source','native','legacy','frozen'].includes(implementation),'known compaction implementation');
const frozen=implementation==='legacy'||implementation==='frozen',dist=resolve(root,frozen?'ui/reference/master-a613970':'ui/dist');
const read=p=>readFileSync(resolve(root,p),'utf8');
const golden=legacyConversation().toString();
const helper=read('ui/overrides/compaction-progress.js');
assert.ok(golden.includes(helper),'maintained patch helper belongs to immutable baseline, not native factory');
const source=frozen?golden:verifyConversationArtifact();
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'));
const engine=process.env.UI_TEST_BROWSER??'chromium';
const browser=await require('playwright')[engine].launch({headless:true});
const artifacts=process.env.UI_TEST_ARTIFACTS;
if(artifacts) mkdirSync(artifacts,{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:1000,height:720}});
 const errors=[];page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)});
 await installOwnedViewPlatform(page,frozen?'legacy':'source');
 await page.addStyleTag({content:'body{font:14px system-ui;margin:0;background:#fff;color:#171717;--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#717171;--dsw-alias-line-secondary:#e5e5e5}main{max-width:760px;margin:80px auto;padding:24px}button{color:inherit;font:inherit}'});
 await page.evaluate(()=>{document.body.innerHTML='<main><h2>Context compaction</h2><p>Isolated UI regression · no model requests</p><div id="root"></div></main>';window.registrations={};window.__ModuleLoader__={load:registration=>registrations[registration.id]=registration}});
 for(const name of readdirSync(resolve(dist,'plugins/@xharness'))){
  let content=readFileSync(resolve(dist,'plugins/@xharness',name,'client.js'),'utf8');
  if(name==='dsh-client-ui-conversation'){
   assert.equal(content,source,'selected fresh/immutable Conversation artifact');
   content=exposeConversation(content,['CompactionProgressCard','en','zh']);
  }
  await page.addScriptTag({content});
 }
 await page.evaluate(()=>{
  const cache={};function load(id){if(staticModules[id])return staticModules[id];const key=id.endsWith('/client')?id.slice(0,-7):id;if(cache[key])return cache[key];if(!registrations[key])throw Error('Missing actual compaction dependency '+id);return cache[key]=registrations[key].factory(load)}
  const api=load('@xharness/dsh-client-ui-conversation/client');
  const react=staticModules.react,D=staticModules['react-dom'],dicts={zh:api.zh,en:api.en};
  window.Card=api.CompactionProgressCard;
  const root=D.createRoot(document.getElementById('root'));
  const nativeSet=setInterval,nativeClear=clearInterval, timers=new Set();
  window.setInterval=(...args)=>{const id=nativeSet(...args);timers.add(id);return id;};
  window.clearInterval=id=>{timers.delete(id);nativeClear(id);};window.timerCount=()=>timers.size;
  window.render=(data,locale='zh',key='a')=>D.flushSync(()=>root.render(data ? react.createElement(Card,{data,t:(key,args={})=>{
    let text=dicts[locale][key];if(text===undefined)throw Error('Missing actual compaction locale '+locale+'/'+key);for(const [name,value] of Object.entries(args)) text=text.replaceAll('{'+name+'}',String(value));return text;
  },key}) : null));
  window.running={kind:'compaction',status:'running',seq:10,time:Date.now()-154000,error:null,progressTime:Date.now(),progress:{stage:'retrying',calls:3,completedParts:1,splits:1,retries:2,delayMs:5000,inputTokensBefore:180000}};
  render(running);
 });
 const card=page.locator('[data-compaction-progress]');
 assert.equal(await page.evaluate(()=>timerCount()),0,'minimal status does not allocate a per-row clock or countdown');
 assert.equal(await card.getByRole('button').count(),0,'running state is a single status, not another detail control');
 assert.equal(await card.getByRole('progressbar').count(),0);
 assert.ok((await card.getByRole('status').innerText()).endsWith('正在压缩… · 可能需要几分钟'));
 const minimalText=await card.innerText();
 for(const stage of ['preparing','summarizing','splitting','merging','retrying','validating','committing']) {
  await page.evaluate(stage=>render({...running,progress:{...running.progress,stage,calls:77,retries:70,delayMs:stage==='retrying'?30000:undefined}}),stage);
  assert.equal(await card.innerText(),minimalText,'internal stage/count updates must not expand or flicker the status');
  assert.equal(await page.evaluate(()=>timerCount()),0);
 }
 await page.evaluate(()=>render({...running,progress:{...running.progress,stage:'paused',delayMs:undefined}}));
 assert.ok((await card.getByRole('status').innerText()).endsWith('压缩已暂停 · 恢复后继续'),'pause is truthful, not a running placeholder');
 await page.evaluate(()=>render(running,'en'));
 assert.ok((await card.getByRole('status').innerText()).endsWith('Compacting context… · May take a few minutes'));
 assert.doesNotMatch(await card.innerText(),/\d|%|Retry|requests/,'no visible counter, time or fabricated percentage');
 const failure={status:'failed',seq:10,time:1000,error:'network failed / '+ 'long-identifier-'.repeat(80)};
 await page.evaluate(failure=>render(failure,'en'),failure);
 assert.ok((await card.getByRole('alert').innerText()).includes('Original history unchanged'),'failure stays visible even before details expand');
 assert.equal(await card.locator('button').getAttribute('aria-expanded'),'false');
 await card.locator('button').click();
 assert.ok((await card.innerText()).includes('network failed'));
 await page.evaluate(failure=>render({...failure,error:'HTTP 401: invalid credentials'},'en'),failure);
 assert.equal(await card.locator('button').getAttribute('aria-expanded'),'true','updates preserve error disclosure');
 await page.evaluate(failure=>render(failure,'en','session-b'),failure);
 assert.equal(await card.locator('button').getAttribute('aria-expanded'),'false','session identity isolates error disclosure');
 for(const theme of ['light','dark']) for(const width of [360,715,1440]) {
  await page.setViewportSize({width,height:720});
  await page.evaluate(theme=>{document.body.style.background=theme==='dark'?'#101010':'#fff';document.body.style.color=theme==='dark'?'#f5f5f5':'#171717';document.body.style.setProperty('--dsw-alias-label-secondary',theme==='dark'?'#a3a3a3':'#717171');},theme);
  for(const locale of ['zh','en']) {
   await page.evaluate(locale=>render(running,locale,'responsive-'+locale),locale);
   assert.equal(await card.getByRole('status').count(),1);
   await page.evaluate(({failure,locale})=>render(failure,locale,'failure-'+locale),{failure,locale});
   assert.equal(await card.getByRole('alert').count(),1);
   assert.equal(await card.getByRole('status').count(),0,'terminal errors cannot remain running');
   await card.locator('button').click();
   assert.ok((await card.innerText()).includes('network failed'));
   const size=await page.evaluate(()=>({full:document.documentElement.scrollWidth,window:innerWidth}));
   assert.ok(size.full<=size.window+1,JSON.stringify({theme,width,locale,size}));
  }
 }
 await page.evaluate(()=>render({status:'failed',seq:10,time:1000},'zh','without-error'));
 assert.equal(await card.locator('button').isEnabled(),false,'legacy terminal errors without detail are not empty disclosures');
 await page.setViewportSize({width:1000,height:720});
 await page.evaluate(()=>{document.body.style.background='#fff';document.body.style.color='#171717';document.body.style.setProperty('--dsw-alias-label-secondary','#717171');render(running,'zh','preview');});
 if(artifacts) await page.screenshot({path:resolve(artifacts,`compaction-progress-${engine}-${implementation}.png`),fullPage:true});
 await page.evaluate(()=>render(null));
 assert.equal(await page.evaluate(()=>timerCount()),0);
 assert.deepEqual(errors,[]);
 console.log(`${engine}/${implementation}: minimal shipped compaction UI passed; stable bilingual status through seven stages/70 retries, truthful pause, no clocks/bars/counts, error disclosure/session isolation, 12 responsive locale/theme cases, no leaked timers; no Host/model calls`);
} finally {await browser.close();}
