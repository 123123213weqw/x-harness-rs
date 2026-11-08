// Synthetic, isolated experiments; never loaded by product assembly. Byte/pixel
// accounting below is NOT an OS physical-footprint or native decoder guarantee.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {compileSourceModules} from '../build-source-modules.mjs'
import {installOwnedViewHtml} from './owned-view-platform-browser.mjs'
import {DecodedImageBudget,syntheticPng,thumbnailSize} from './ui-memory-policies.mjs'
export async function runImageMemoryExperiments(browser,engine){
 const specs=[['messages','src/modules/attachment/MessageImages.tsx'],['lightbox','src/modules/attachment/ImageLightbox.tsx'],['raster','src/modules/browser/file-display/ImagePreview.tsx']]
 const compiled=compileSourceModules(resolve('ui'),specs.map(([id,source])=>({id,source})))
 const page=await browser.newPage({viewport:{width:1000,height:900},locale:'en-US'}),errors=[]
 page.on('pageerror',error=>{if(!error.message.includes('owned feature fixture: stop Host boot'))errors.push(error.message)})
 try{
  await installOwnedViewHtml(page,'source','<html><head></head><body><div id="root" style="width:650px"></div></body></html>',{origin:'https://isolated-memory-experiment.test'})
  for(const file of ['MessageImage','ImageLightbox'])await page.addStyleTag({content:readFileSync(`ui/src/modules/attachment/${file}.css`,'utf8')})
  await page.evaluate(()=>{window.modules={};window.__ModuleLoader__={load:r=>modules[r.id]=r}})
  for(const [id] of specs)await page.addScriptTag({content:compiled.get(id).bytes.toString()})
  const resources=new Map(),network=[];let phase='baseline'
  const records=[[3200,2000],[2000,3200],[3200,2000],[32,24]].map(([width,height],id)=>{
   const thumb=thumbnailSize(width,height)
   const original=`https://isolated-memory-experiment.test/image-fixture/original/${id}.png`,thumbnail=`https://isolated-memory-experiment.test/image-fixture/thumbnail/${id}.png`
   resources.set(original,syntheticPng(width,height,id+1));resources.set(thumbnail,syntheticPng(thumb.width,thumb.height,id+1))
   return {id,width,height,thumb,original,thumbnail}
  })
  await page.route('**/image-fixture/**',route=>{const url=route.request().url(),key=new URL(url);key.search='';const body=resources.get(key.href);assert.ok(body,'unknown synthetic image');network.push({phase,original:url.includes('/original/'),bytes:body.length});return route.fulfill({contentType:'image/png',body})})
  await page.evaluate(({records,budgetSource,rasterData})=>{
   window.records=records;window.loads=[];window.blobs=new Set();window.created=0;window.revoked=0
   const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL)
   URL.createObjectURL=blob=>{if(window.failNextImageURL){window.failNextImageURL=false;throw Error('synthetic URL allocation failure')}const url=create(blob);blobs.add(url);created++;return url};URL.revokeObjectURL=url=>{if(blobs.delete(url))revoked++;revoke(url)}
   window.Budget=Function('return ('+budgetSource+')')();window.budget=new Budget(128*1024*1024)
   const resolve=id=>staticModules[id]??(()=>{throw Error('Unknown module '+id)})()
   window.MessageImages=modules.messages.factory(resolve).MessageImages;window.Lightbox=modules.lightbox.factory(resolve).ImageLightbox;window.Raster=modules.raster.factory(resolve).ImagePreview
   window.root=ReactDOM.createRoot(document.getElementById('root'))
   const jsx=React.createElement
   root.render(jsx(MessageImages,{images:records.map(r=>({kind:'image',attachment:{attachmentId:String(r.id),name:'image-'+r.id,width:r.width,height:r.height,bytes:100}})),loadImage:async ref=>{loads.push({kind:'original',id:ref.attachmentId});return records[Number(ref.attachmentId)].original},align:'end',t:key=>key}))
   window.Prototype=function Prototype(){
    const [selected,choose]=React.useState(null),[src,setSrc]=React.useState(null)
    React.useEffect(()=>{
     const leases=records.map(r=>{const lease=budget.reserve(r.thumb.width,r.thumb.height);if(!lease)throw Error('Thumbnail budget unexpectedly full');return lease})
     return()=>leases.forEach(lease=>lease.release())
    },[])
    React.useEffect(()=>{
     setSrc(null);if(selected===null)return
     const r=records[selected],lease=budget.reserve(r.width,r.height);if(!lease)throw Error('Original admission denied')
     let alive=true;loads.push({kind:'original',id:r.id})
     const wait=window.holdOriginal?new Promise(resolve=>window.finishOriginal=resolve):Promise.resolve()
     void wait.then(()=>{if(alive)setSrc(r.original+'?clicked-original=1')})
     return()=>{alive=false;lease.release()}
    },[selected])
    return jsx('div',null,records.map(r=>jsx('button',{key:r.id,'data-thumb':r.id,onClick:()=>choose(r.id)},jsx('img',{src:r.thumbnail,alt:'thumbnail-'+r.id,style:{maxWidth:240,maxHeight:240}}))),selected!==null&&src&&jsx(Lightbox,{src,alt:'full-original',labels:{dialog:'Original preview',close:'Close original'},onClose:()=>choose(null)}),selected!==null&&!src&&jsx('button',{'data-cancel-load':true,onClick:()=>choose(null)},'Cancel pending original'))
   }
   window.renderPrototype=()=>{loads=[];ReactDOM.flushSync(()=>root.render(jsx(Prototype)))}
   window.rasterBlob=new Blob([Uint8Array.from(atob(rasterData),c=>c.charCodeAt(0))],{type:'image/png'})
   window.renderRaster=(show,key='raster',strict=false)=>{const child=show?jsx(Raster,{key,zoom:0,zh:false,ready:()=>{},image:{blob:rasterBlob,path:'/synthetic/visible.png',width:32,height:24}}):null;ReactDOM.flushSync(()=>root.render(strict?jsx(React.StrictMode,null,child):child))}
  },{records,budgetSource:DecodedImageBudget.toString(),rasterData:syntheticPng(32,24).toString('base64')})
  await page.locator('#root img').first().waitFor();assert.equal(await page.locator('#root img').count(),4)
  await page.locator('#root img').evaluateAll(async imgs=>{await Promise.all(imgs.map(img=>img.decode()))})
  const baseline=await page.locator('#root img').evaluateAll(imgs=>imgs.reduce((n,img)=>n+img.naturalWidth*img.naturalHeight*4,0))
  assert.equal(await page.evaluate(()=>loads.length),4)
  assert.equal(network.filter(row=>row.original).length,4);phase='prototype'
  await page.evaluate(()=>renderPrototype());await page.locator('[data-thumb] img').evaluateAll(async imgs=>{await Promise.all(imgs.map(img=>img.decode()))})
  const preview=await page.locator('[data-thumb] img').evaluateAll(imgs=>imgs.reduce((n,img)=>n+img.naturalWidth*img.naturalHeight*4,0))
  assert.ok(preview<baseline*.03);assert.equal(await page.evaluate(()=>loads.length),0,'idle thumbnails do not request original bytes');assert.equal(network.filter(row=>row.phase==='prototype'&&row.original).length,0)
  assert.deepEqual(await page.locator('[data-thumb="1"] img').evaluate(img=>[img.naturalWidth,img.naturalHeight]),[300,480],'portrait stays portrait')
  assert.deepEqual(await page.locator('[data-thumb="3"] img').evaluate(img=>[img.naturalWidth,img.naturalHeight]),[32,24],'small source never upscales')
  await page.locator('[data-thumb="0"]').click();await page.getByRole('dialog').waitFor();await page.getByRole('dialog').locator('img').evaluate(img=>img.decode())
  assert.deepEqual(await page.getByRole('dialog').locator('img').evaluate(img=>[img.naturalWidth,img.naturalHeight]),[3200,2000])
  assert.equal(network.filter(row=>row.phase==='prototype'&&row.original).length,1,'only clicked original crosses the synthetic transport')
  assert.equal(await page.evaluate(()=>loads.length),1);await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>budget.stats.used),preview)
  await page.evaluate(()=>{holdOriginal=true});await page.locator('[data-thumb="1"]').click();await page.locator('[data-cancel-load]').click();await page.evaluate(()=>finishOriginal());await page.waitForTimeout(30)
  assert.equal(await page.getByRole('dialog').count(),0,'cancelled original cannot reopen a modal');assert.equal(await page.evaluate(()=>budget.stats.used),preview)
  // Production URL lease; the parent owns compressed bytes, never a second RPC.
  for(let i=0;i<8;i++){
   await page.evaluate(i=>renderRaster(true,'round-'+i,i>=4),i)
   await page.locator('.xhfile-image img').evaluate(img=>img.decode());assert.equal(await page.evaluate(()=>blobs.size),1)
   await page.evaluate(()=>renderRaster(false));assert.equal(await page.evaluate(()=>blobs.size),0)
  }
  await page.evaluate(()=>{failNextImageURL=true;renderRaster(true,'allocation-failure')});await page.getByRole('alert').filter({hasText:'synthetic URL allocation failure'}).waitFor()
  assert.equal(await page.evaluate(()=>blobs.size),0);await page.getByRole('button',{name:'Retry',exact:true}).click();await page.locator('.xhfile-image img').evaluate(img=>img.decode());await page.evaluate(()=>renderRaster(false))
  assert.equal(await page.evaluate(()=>created-revoked),0);assert.equal(await page.evaluate(()=>budget.stats.used),0)
  assert.deepEqual(errors,[])
  return {engine,syntheticOnly:true,baselineNominalRgbaBytes:baseline,thumbnailNominalRgbaBytes:preview,baselineSyntheticImageBytes:network.filter(row=>row.phase==='baseline').reduce((n,row)=>n+row.bytes,0),thumbnailSyntheticImageBytes:network.filter(row=>row.phase==='prototype'&&!row.original).reduce((n,row)=>n+row.bytes,0),originalOnlyOnZoom:true,portraitAndNoUpscale:true,decodedBudgetReservedBeforeLoads:true,cancelledZoomNoResurrection:true,productionRasterCompressedRevisit:true,URLAllocationFailureRetry:true,repeatedRasterCycles:8,liveBlobUrlsAfterCycles:0,measurement:'decoded pixel accounting and URL ownership; not OS footprint',transportScope:'synthetic prototype; production session thumbnail and admission covered by attachment gates',notEnabledByDefault:['forced PDF unload','tighter session LRU']}
 }finally{await page.close()}
}
