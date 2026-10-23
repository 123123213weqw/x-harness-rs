import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setImmediate as immediate} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startFixture} from './fixture.mjs';
const {BrowserUseEngine}=await import(process.env.BROWSER_ENGINE_MODULE?pathToFileURL(process.env.BROWSER_ENGINE_MODULE).href:new URL('../../plugins/browser-use/dist/engine.js',import.meta.url).href);

// Deterministic public-Page event ordering: the old document is already loaded,
// but a failed main navigation has not finished committing/loading its error page.
// This stub tests settlement, not origin enforcement; real Chromium is below.
class PageBoundary extends EventEmitter {
 main={};closed=false;
 mainFrame(){return this.main;}
 isClosed(){return this.closed;}
 request(){this.emit('request',{isNavigationRequest:()=>true,frame:()=>this.main});}
 commit(frame=this.main){this.emit('framenavigated',frame);}
 async waitForLoadState(){} // The previous document's state is already complete.
 waitForEvent(name,{predicate=()=>true,timeout=2000}={}){
  return new Promise((resolve,reject)=>{
   const stop=()=>{clearTimeout(timer);this.off(name,listen);};
   const listen=value=>{if(predicate(value)){stop();resolve(value);}};
   const timer=setTimeout(()=>{stop();reject(Error('fixture event timeout'));},timeout);
   this.on(name,listen);
  });
 }
}
const settle=(page,operation)=>BrowserUseEngine.prototype.navigateSettled.call(null,page,operation);
const listeners=page=>['request','framenavigated','load','close'].reduce((total,name)=>total+page.listenerCount(name),0);
async function tick(){await immediate();await immediate();}

for(const mode of ['commit-before-rejection','commit-after-rejection','previous-load-before-main-commit','newer-main-navigation'])
 test(`failed navigation waits for its future main document: ${mode}`,{timeout:5000},async()=>{
  const page=new PageBoundary(),failure=Error('fixture blocked redirect');let settled=false,calls=0;
  const result=settle(page,async()=>{
   calls++;page.request();
   if(mode==='commit-before-rejection')page.commit();
   if(mode==='previous-load-before-main-commit'){page.commit({child:true});page.emit('load');}
   if(mode==='newer-main-navigation'){page.commit();page.emit('load');page.request();page.commit();}
   throw failure;
  }).then(()=>assert.fail('the rejected effect must stay rejected'),error=>{assert.equal(error,failure);settled=true;});
  try{
   await tick();assert.equal(settled,false,'an old/child document cannot certify terminal navigation');
   if(mode!=='commit-before-rejection'&&mode!=='newer-main-navigation')page.commit();
   page.emit('load');await result;
   assert.equal(calls,1,'never replay a navigation to obtain a nicer receipt');
   assert.equal(listeners(page),0,'all settlement observers must be removed');
  }finally{page.commit();page.emit('load');await result;}
 });

test('successful non-navigation history operation leaves no pending waiter',{timeout:4000},async()=>{
 const page=new PageBoundary();let calls=0;
 await settle(page,async()=>{calls++;});
 assert.equal(calls,1);assert.equal(listeners(page),0);
});
test('closed page releases a pending failed-navigation barrier and preserves the error',{timeout:4000},async()=>{
 const page=new PageBoundary(),failure=Error('fixture closed');let settled=false;
 const result=settle(page,async()=>{page.request();throw failure;}).catch(error=>{assert.equal(error,failure);settled=true;});
 await tick();assert.equal(settled,false);
 page.closed=true;page.emit('close');await result;assert.equal(listeners(page),0);
});
test('missing terminal events remain bounded and never replay the failed operation',{timeout:5000},async()=>{
 const page=new PageBoundary(),failure=Error('fixture unfinished');let calls=0;
 await assert.rejects(()=>settle(page,async()=>{calls++;page.request();throw failure;}),error=>error===failure);
 assert.equal(calls,1);assert.equal(listeners(page),0);
});

test('real blocked redirect chains settle before the next allowed parent navigation',{timeout:90000},async()=>{
 const fixture=await startFixture(),root=await mkdtemp(join(tmpdir(),'xh-nav-settle-'));
 const engine=await BrowserUseEngine.create({artifactRoot:root,allowedOrigins:[fixture.origin]});
 try{
  const page=engine.context.pages()[0];let parentRequests=0;
  page.on('request',request=>{if(request.url().startsWith(fixture.origin+'/iframe-redirect-page'))parentRequests++;});
  for(let iteration=0;iteration<12;iteration++){
   const failed=await engine.execute({action:'navigate',url:fixture.origin+'/redirect-chain?id=origin'});
   assert.equal(failed.outcome,'possibly-applied');assert.equal(failed.replaySafe,false);
   const recovered=await engine.execute({action:'navigate',url:fixture.origin+'/iframe-redirect-page?id=origin'});
   assert.equal(recovered.outcome,'applied',JSON.stringify(recovered));
   // Successful navigate promises DOMContentLoaded, not completion of the child
   // redirect. Settle this controlled fixture before asserting one snapshot;
   // concurrent navigation must still invalidate observations, never be ignored.
   await page.waitForLoadState('load',{timeout:3000});
   const observed=await engine.execute({action:'observe'});
   assert.equal(observed.outcome,'applied',JSON.stringify({iteration,observed}));assert.match(observed.result.text,/Allowed parent/);
   assert.equal(fixture.foreignRequests.length,0,'all direct/redirected iframe traffic remains blocked');
  }
  assert.equal(parentRequests,12,'each explicit allowed navigation is dispatched once');
 }finally{await engine.close();await fixture.close();await rm(root,{recursive:true,force:true});}
});
