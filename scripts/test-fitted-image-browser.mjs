// Real production components, shared singleton resources and strict wire client.
// All files, RPCs and images are synthetic. No existing App or Host is touched.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve,dirname} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
import {installSharedSourceVendors} from './fixtures/shared-source-vendors.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium',browser=await require('playwright')[engine].launch({headless:true})
const entries=[['fit','FittedImagePreview.tsx'],['client','client.ts'],['pdf','PdfPreview.tsx']]
const built=compileSourceModules('ui',entries.map(([id,file])=>({id,source:'src/modules/browser/file-display/'+file})))
try{
 const page=await browser.newPage({viewport:{width:1400,height:900},deviceScaleFactor:2}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000)
 await page.setContent('<div id="panel" style="width:600px;height:480px"><div id="root" style="width:100%;height:100%;padding:20px;box-sizing:border-box"></div></div>')
 // Resolve React from the unchanged repository dependencies, not this test tool.
 const ui=createRequire(resolve('ui/package.json'))
 for(const name of ['react','react-dom'])await page.addScriptTag({path:resolve(dirname(ui.resolve(name+'/package.json')),'umd',name+'.development.js')})
 await installSharedSourceVendors(page)
 await page.addScriptTag({content:'window.registrations={};window.__ModuleLoader__={load:r=>registrations[r.id]=r}'})
 for(const [id] of entries)await page.addScriptTag({content:built.get(id).bytes.toString()})
 await page.evaluate(()=>{
  const deps=name=>({'react':React,'react/jsx-runtime':{jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key}),Fragment:React.Fragment},'@xharness/dsh-client-ui-primitives':__sourceVendors.imageResources,'zod':__sourceVendors.zod}[name])
  window.Fit=registrations.fit.factory(deps).FittedImagePreview;window.Pdf=registrations.pdf.factory(deps).PdfPreview
  const Client=registrations.client.factory(deps).FileDisplayClient
  window.calls=[];window.sourceWidth=3200;window.sourceHeight=2000;window.oldHost=false;window.changed=false;window.hold=false;window.open=true;window.zoom=0;window.generation=0;window.ready=0
  const png=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle='#102030';ctx.fillRect(0,0,w,h);ctx.fillStyle='white';ctx.font='18px monospace';ctx.fillText('Thin text 123 / 细节',10,30);return c.toDataURL('image/png').split(',')[1]}
  window.client=new Client({call:async(channel,endpoint,args,signal)=>{
   calls.push({endpoint,...args});if(hold)await new Promise(resolve=>window.finishRead=resolve)
   signal.throwIfAborted()
   if(endpoint==='display/read')return {ok:true,value:{kind:'image',path:args.path,mediaType:'image/png',width:3200,height:2000,dataBase64:png(3200,2000)}}
   if(oldHost)return {ok:false,error:{message:'unknown endpoint'}}
   if(changed&&args.expectedSourceId)return {ok:false,error:{message:'image changed; refresh preview'}}
   const scale=args.original?1:Math.min(1,args.maxWidth/sourceWidth,args.maxHeight/sourceHeight),width=Math.max(1,Math.floor(sourceWidth*scale)),height=Math.max(1,Math.floor(sourceHeight*scale))
   return {ok:true,value:{path:args.path,mediaType:'image/png',dataBase64:png(width,height),width,height,sourceWidth,sourceHeight,sourceId:'snapshot-A',original:args.original}}
  }})
  window.root=ReactDOM.createRoot(document.getElementById('root'));window.draw=()=>ReactDOM.flushSync(()=>root.render(React.createElement(React.StrictMode,{},React.createElement(Fit,{key:generation,path:'/workspace/diag.png',sessionId:'s',client,open,zoom,ready:()=>ready++,zh:true}))));draw()
 })
 await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0)
 const initial=await page.evaluate(()=>({calls,img:document.querySelector('img').naturalWidth,url:document.querySelector('img').src,budget:__sourceVendors.imageResources.decodedImageBudget.bytes}))
 assert.equal(initial.calls.length,1);assert.equal(initial.calls[0].maxWidth,1120,'600 CSS px panel minus padding at DPR2');assert.equal(initial.img,1120);assert.ok(initial.budget<16*1024*1024)
 await page.evaluate(()=>{open=false;draw()});await page.waitForFunction(()=>document.querySelectorAll('img').length===0)
 assert.equal(await page.evaluate(()=>__sourceVendors.imageResources.decodedImageBudget.bytes),initial.budget,'hidden URL stays charged')
 await page.evaluate(()=>{open=true;draw()});await page.waitForFunction(()=>document.querySelector('img')?.complete)
 assert.equal(await page.locator('img').getAttribute('src'),initial.url);assert.equal(await page.evaluate(()=>calls.length),1,'showing the same snapshot must not decode a fresh URL')
 await page.evaluate(()=>{zoom=125;draw()});await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth===3200)
 assert.equal(await page.evaluate(()=>calls.at(-1).expectedSourceId),'snapshot-A');const fullUrl=await page.locator('img').getAttribute('src')
 await page.evaluate(()=>{zoom=0;draw()});await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth===1120)
 assert.equal(await page.locator('img').getAttribute('src'),initial.url)
 await page.evaluate(()=>{zoom=125;draw()});await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth===3200);assert.equal(await page.locator('img').getAttribute('src'),fullUrl);assert.equal(await page.evaluate(()=>calls.length),2)
 await page.evaluate(()=>{zoom=0;document.getElementById('panel').style.height='640px';document.getElementById('panel').style.width='800px';draw()})
 await page.waitForFunction(()=>calls.length===3&&document.querySelector('img')?.naturalWidth>1120)
 await page.evaluate(()=>{changed=true;document.getElementById('panel').style.width='1000px';document.getElementById('panel').style.height='800px'})
 await page.getByRole('alert').filter({hasText:'image changed'}).waitFor();assert.equal(await page.evaluate(()=>document.querySelector('img')?.naturalWidth<3200),true)
 // Hiding/closing pending work neither installs a late decoder nor reopens UI.
 await page.evaluate(()=>{changed=false;hold=true;generation++;draw()});await page.waitForFunction(()=>typeof finishRead==='function')
 await page.evaluate(()=>{open=false;draw();hold=false;finishRead()});await page.waitForTimeout(100);assert.equal(await page.locator('img').count(),0)
 await page.evaluate(()=>{root.render(null)});await page.waitForFunction(()=>__sourceVendors.imageResources.imageUrlPool.size===0);assert.equal(await page.evaluate(()=>__sourceVendors.imageResources.decodedImageBudget.bytes),0)
 // An older Host must not silently fall back to a full original in fit mode.
 await page.evaluate(()=>{oldHost=true;open=true;zoom=0;calls=[];generation++;draw()});await page.getByRole('alert').filter({hasText:'unknown endpoint'}).waitFor()
 assert.equal(await page.evaluate(()=>calls.some(c=>c.endpoint==='display/read')),false)
 await page.getByRole('button',{name:'查看原图',exact:true}).click();await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth===3200)
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.endpoint==='display/read').length),1)
 await page.evaluate(()=>root.render(null));await page.waitForFunction(()=>__sourceVendors.imageResources.decodedImageBudget.bytes===0)
 // Height-limited portrait previews must remain 2x physical pixels, not
 // accidentally render their physical height as CSS height on Retina.
 await page.evaluate(()=>{oldHost=false;sourceWidth=2000;sourceHeight=3200;generation++;document.getElementById('panel').style.width='600px';document.getElementById('panel').style.height='480px';draw()})
 await page.waitForFunction(()=>document.querySelector('img')?.naturalHeight===808)
 const portrait=await page.locator('img').evaluate(img=>({width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight}))
 assert.ok(portrait.height<=404.1&&portrait.height>=403.9,JSON.stringify(portrait));assert.ok(portrait.naturalWidth/portrait.width>=1.99,JSON.stringify(portrait))
 await page.evaluate(()=>{sourceWidth=32;sourceHeight=24;generation++;draw()});await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth===32)
 assert.equal(await page.locator('img').evaluate(img=>img.getBoundingClientRect().width),32,'small images retain intrinsic CSS size')
 await page.evaluate(()=>root.render(null));await page.waitForFunction(()=>__sourceVendors.imageResources.decodedImageBudget.bytes===0)
 // Do not issue a blurry 1x1 derivative during a zero-sized pane transition.
 const beforeZero=await page.evaluate(()=>calls.length)
 await page.evaluate(()=>{sourceWidth=3200;sourceHeight=2000;generation++;document.getElementById('panel').style.width='0px';document.getElementById('panel').style.height='0px';draw()});await page.waitForTimeout(250)
 assert.equal(await page.evaluate(()=>calls.length),beforeZero)
 await page.evaluate(()=>{document.getElementById('panel').style.width='600px';document.getElementById('panel').style.height='480px'})
 await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth===1120)
 await page.evaluate(()=>root.render(null));await page.waitForFunction(()=>__sourceVendors.imageResources.decodedImageBudget.bytes===0)
 // PDF viewer teardown is explicit; the warning never promises retained position.
 await page.evaluate(()=>root.render(React.createElement(Pdf,{url:'about:blank',zh:true})));await page.locator('iframe').waitFor()
 await page.getByRole('button',{name:'暂停 PDF 预览',exact:true}).click();assert.equal(await page.locator('iframe').count(),0)
 await page.getByRole('button',{name:'恢复 PDF 预览',exact:true}).click();await page.locator('iframe').waitFor()
 await page.evaluate(()=>root.unmount());assert.deepEqual(errors,[])
 console.log(engine+': DPR fit, exact original zoom, stable URL reuse/charged hidden cache, resize, source binding, late cancellation, StrictMode, old Host fallback and explicit PDF pause passed')
}finally{await browser.close()}
