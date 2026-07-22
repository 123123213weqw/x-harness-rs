// Real-browser old/new acceptance over isolated React root and fake Host loader.
import assert from 'node:assert/strict'
import {readFileSync}from'node:fs'
import {createRequire}from'node:module'
import{resolve}from'node:path'
import{compileSourceModules}from'./build-source-modules.mjs'
const id='@xharness/dsh-client-ui-attachment';
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','package.json'));
const{chromium,webkit}=require('playwright');const engine=process.env.UI_TEST_BROWSER??'chromium';
const source=process.env.UI_TEST_IMPL==='legacy'?readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8'):compileSourceModules('ui',[{id,source:'src/modules/attachment/index.ts'}]).get(id).bytes.toString();
const browser=await({chromium,webkit}[engine]).launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:900,height:620}});page.setDefaultTimeout(10000);page.on('pageerror',error=>{throw error});
 await page.setContent('<html><head></head><body><div id="root" style="width:420px"></div></body></html>');
 for(const file of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','node_modules',file)});
 await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>window.registration=row}'});await page.addScriptTag({content:source});
 await page.evaluate(()=>{
  const api=registration.factory(name=>name==='react'?React:name==='react-dom'?ReactDOM:name==='react/jsx-runtime'?{jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key}),Fragment:React.Fragment}:new Proxy({}, {get:()=>()=>null}));
  window.slots={};api.apply({slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>{slots[spec.name]=component}}});
  window.root=ReactDOM.createRoot(document.getElementById('root'));window.removed=[];window.added=[];window.loads=[];window.fail=false;window.mode='draft';window.canAccept=true;
  window.png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  window.attachments=[{id:'p',kind:'image',file:new File(['x'],'photo.png',{type:'image/png'}),previewUrl:png},{id:'f',kind:'file',file:new File(['hello'],'notes.txt',{type:'text/plain'})}];
  window.images=[{kind:'image',attachment:{attachmentId:'p',name:'photo.png',bytes:30,width:800,height:600}},{kind:'file',attachment:{attachmentId:'f',name:'notes.txt',bytes:2048}}];
  const t=(key,values)=>({'image.pending':'Draft attachments','image.openOriginal':'Open original','image.preview':'Image preview','image.closePreview':'Close preview','image.label':'Image','image.loading':'Loading image','image.loadFailed':'Image failed, retry','image.dropBlocked':'Drop unavailable','image.scrollLeft':'Scroll left','image.scrollRight':'Scroll right','image.remove':'Remove '+values?.name,'image.openOriginalLabel':'Open '+values?.label}[key]??key);
  const add=files=>added.push(...files.map(x=>x.name));const remove=id=>{removed.push(id);attachments=attachments.filter(x=>x.id!==id);render()};
  const load=async ref=>{loads.push(ref);if(fail)throw Error('failed');return png};
  window.render=()=>root.render(mode==='draft'?React.createElement(slots['conversation.input.attachments'],{attachments,canAcceptDrop:canAccept,onAddImages:add,onRemoveImage:remove,t}):React.createElement(slots['conversation.message.images'],{images,loadImage:load,align:'end',t}));render();
 });
 await page.getByText('notes.txt').waitFor();assert.equal(await page.getByRole('img',{name:'photo.png'}).count(),1);
 await page.getByTitle('Open original',{exact:true}).click();await page.getByRole('dialog',{name:'Image preview'}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
 await page.getByRole('button',{name:'Remove notes.txt',exact:true}).click();assert.deepEqual(await page.evaluate(()=>removed),['f']);
 // Document drop nesting, mixed files, refusal and drag-end cleanup.
 await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['x'],'drop.txt'));window.transfer=transfer;document.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}))});
 await page.getByRole('status').waitFor();await page.getByText('拖入图片或文件').waitFor();
 await page.evaluate(()=>document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})));await page.getByRole('status').waitFor({state:'detached'});assert.deepEqual(await page.evaluate(()=>added),['drop.txt']);
 await page.evaluate(()=>{canAccept=false;render()});await page.waitForTimeout(40);
 await page.evaluate(()=>document.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer})));await page.getByText('Drop unavailable').waitFor();
 await page.evaluate(()=>document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})));assert.deepEqual(await page.evaluate(()=>added),['drop.txt']);
 await page.evaluate(()=>{mode='history';fail=true;render()});await page.getByRole('button',{name:'Image failed, retry',exact:true}).waitFor();
 await page.evaluate(()=>{fail=false});await page.getByRole('button',{name:'Image failed, retry',exact:true}).click();await page.getByRole('button',{name:'Open photo.png'}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Close preview'}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 await page.evaluate(()=>{fail=true});await page.getByRole('button',{name:/notes.txt/}).click();await page.getByRole('alert').filter({hasText:'读取失败，点击重试'}).waitFor();
 await page.evaluate(()=>{fail=false});await page.getByRole('button',{name:/notes.txt/}).click();await page.waitForFunction(()=>loads.filter(x=>x.attachmentId==='f').length===2);
 const payloads=await page.evaluate(()=>loads);assert.ok(payloads.every(x=>x.attachmentId==='p'||x.attachmentId==='f'));
 // Single-fit cap, portrait anchoring and history with unavailable dimensions.
 await page.evaluate(()=>{images=[{attachment:{attachmentId:'p',name:'portrait',bytes:30,width:20,height:500}}];render()});await page.getByRole('img',{name:'portrait'}).waitFor();
 const rect=await page.getByRole('button',{name:'Open portrait'}).boundingBox();assert.ok(rect.width<=64&&rect.height<=90,JSON.stringify(rect));
 await page.evaluate(()=>{images=[{attachment:{attachmentId:'f',name:'unknown-dimensions',bytes:50}}];render()});await page.getByText('unknown-dimensions').waitFor();assert.equal(await page.getByRole('img').count(),0);
 // All document handlers must leave with the source slot.
 await page.evaluate(()=>root.unmount());await page.evaluate(()=>document.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer})));assert.equal(await page.getByRole('status').count(),0);
 console.log(`${engine} ${process.env.UI_TEST_IMPL??'source'}: draft files/images, preview/Escape, nested drop/refusal, history retry/download, durable reference payload, sizing and teardown passed`);
}finally{await browser.close()}
