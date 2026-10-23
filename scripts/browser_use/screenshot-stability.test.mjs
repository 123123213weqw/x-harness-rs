import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {BrowserUseEngine}=await import(process.env.BROWSER_ENGINE_MODULE?pathToFileURL(process.env.BROWSER_ENGINE_MODULE).href:new URL('../../plugins/browser-use/dist/engine.js',import.meta.url).href);

// Test-only access to the actual Playwright page injects external navigation at
// precise capture boundaries. No production tool/eval hook is added.
async function fixture(run,{lateChild=false}={}){
 let child,notifyChild;const childRequested=new Promise(resolve=>{notifyChild=resolve;});
 const server=createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  if(req.url==='/child'){child=res;notifyChild();return;}
  res.end(`<!doctype html><h1>Capture fixture</h1><button onclick="document.body.dataset.clicked='yes'">Target</button>${lateChild?'<iframe name="late-child" src="/child"></iframe>':''}`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const root=await mkdtemp(join(tmpdir(),'xh-capture-regression-'));
 const engine=await BrowserUseEngine.create({artifactRoot:root,allowedOrigins:[origin]});
 try{
  const page=engine.context.pages()[0];
  assert.equal((await engine.execute({action:'navigate',url:origin})).outcome,'applied');
  if(lateChild)await childRequested;
  await run({engine,page,origin,root,releaseChild:async frame=>{
   assert.ok(child,'child response must still be pending');
   const committed=page.waitForEvent('framenavigated',{predicate:value=>value===frame});
   child.end('<h2>Late child loaded</h2>');child=undefined;await committed;
  }});
 }finally{child?.end('cleanup');await engine.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
}

for(const fullPage of [false,true])test(`late child navigation discards the old capture and publishes a fresh bound raster (fullPage=${fullPage})`,{timeout:15000},async()=>{
 await fixture(async({engine,page,root,releaseChild})=>{
  const frame=page.frames().find(value=>value!==page.mainFrame());assert.ok(frame);
  const evaluate=frame.evaluate.bind(frame);let released=false,reads=0;
  frame.evaluate=async(...args)=>{reads++;if(!released){released=true;await releaseChild(frame);}return evaluate(...args);};
  const receipt=await engine.execute({action:'screenshot',fullPage});
  assert.equal(receipt.outcome,'applied',JSON.stringify(receipt));assert.ok(reads>=3,'fresh geometry must be read after navigation');
  assert.equal(receipt.result.actionable,!fullPage);
  assert.equal((await readdir(root)).filter(name=>name.endsWith('.png')).length,1,'discarded PNGs are removed');
  const tab=engine.tabs.get(receipt.tabId);assert.equal(tab.screenshot.epoch,tab.epoch);
 },{lateChild:true});
});

test('navigation during PNG capture re-captures only; no page action is replayed',{timeout:15000},async()=>{
 await fixture(async({engine,page,origin,root})=>{
  const screenshot=page.screenshot.bind(page);let captures=0,navigations=0;const timeouts=[];
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
  page.screenshot=async options=>{timeouts.push(options.timeout);if(++captures===1)await page.goto(origin+'/?second',{waitUntil:'domcontentloaded'});return screenshot(options);};
  const receipt=await engine.execute({action:'screenshot'});
  assert.equal(receipt.outcome,'applied',JSON.stringify(receipt));assert.equal(captures,2);
  assert.equal(navigations,1,'the externally triggered navigation is never replayed');
  assert.ok(timeouts[1]<timeouts[0],'retry does not reset the PNG timeout budget');
  assert.equal(await page.evaluate(()=>document.body.dataset.clicked),undefined);
  assert.equal((await readdir(root)).filter(name=>name.endsWith('.png')).length,1);
 });
});

test('continuous layout invalidation exhausts three attempts with no actionable capture or leaked PNG',{timeout:15000},async()=>{
 await fixture(async({engine,page,root})=>{
  const screenshot=page.screenshot.bind(page);let captures=0;
  page.screenshot=async options=>{captures++;await page.evaluate(()=>{document.body.style.paddingLeft=`${(parseInt(document.body.style.paddingLeft)||0)+1}px`;});return screenshot(options);};
  const receipt=await engine.execute({action:'screenshot'});
  assert.equal(receipt.outcome,'not-started');assert.match(receipt.error.message,/Layout changed/);assert.equal(captures,3);
  assert.equal(engine.tabs.get(receipt.tabId).screenshot,undefined);
  assert.equal((await readdir(root)).filter(name=>name.endsWith('.png')).length,0);
  assert.equal(await page.evaluate(()=>document.body.dataset.clicked),undefined);
 });
});

test('unrelated screenshot failures are not retried',{timeout:15000},async()=>{
 await fixture(async({engine,page})=>{
  let captures=0;page.screenshot=async()=>{captures++;throw Error('fixture screenshot device unavailable');};
  const receipt=await engine.execute({action:'screenshot'});
  assert.equal(receipt.outcome,'not-started');assert.match(receipt.error.message,/device unavailable/);assert.equal(captures,1);
 });
});

test('image budget rejection never starts or retries PNG capture',{timeout:15000},async()=>{
 await fixture(async({engine,page})=>{
  await page.evaluate(()=>{document.body.style.width='9000px';});
  let captures=0;page.screenshot=async()=>{captures++;throw Error('must not capture oversized page');};
  const receipt=await engine.execute({action:'screenshot',fullPage:true});
  assert.equal(receipt.outcome,'not-started');assert.match(receipt.error.message,/dimensions exceed/);assert.equal(captures,0);
 });
});
