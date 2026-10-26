// Shipped React browser pane + real draft/crop code; native IPC is mocked here.
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const build=createRequire(new URL('../ui/package.json',import.meta.url))('esbuild')
const helpers=build.buildSync({entryPoints:['ui/src/modules/shared/composer-files.ts'],bundle:true,format:'iife',globalName:'ComposerFiles',write:false}).outputFiles[0].text
const engine=process.env.UI_TEST_BROWSER??'chromium',browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[]
 page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
 await installOwnedViewHtml(page,process.env.UI_TEST_IMPL??'source','<html><body><div id="root" style="width:600px;height:600px"></div><div data-composer-card><textarea></textarea></div></body></html>')
 await page.addScriptTag({content:helpers})
 await page.addScriptTag({content:`
 window.calls=[];window.received=[];window.nextPick='pending';window.serial=0;window.__ModuleLoader__={load:x=>window.registration=x};
 window.selection={mode:'element',bounds:{x:100,y:120,width:120,height:60},viewport:{x:0,y:0,width:900,height:700},elements:[{selector:'#primary',tag:'button',text:'Save'}],untrusted:true};
 const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=1400;canvas.getContext('2d').fillRect(200,240,240,120);window.png=canvas.toDataURL('image/png').split(',')[1];
 window.stopReceiver=ComposerFiles.listenComposerFiles('session-one',files=>{window.received.push(files);return null});
 window.__TAURI__={core:{invoke:async(command,args)=>{
  calls.push({command,args});
  if(command==='desktop_browser_activate')return true;
  if(command==='desktop_browser_pick'){
   if(args.request.action==='start'){if(window.holdStart)await new Promise(r=>window.releaseStart=r);return {status:'pending',token:'token-'+(++serial)}}
   if(args.request.action==='cancel')return {status:'cancelled'};
   if(window.holdPoll)await new Promise(r=>window.releasePoll=r);
   return nextPick==='selected'?{status:'selected',selection:window.selection,image:{png_base64:window.png}}:{status:nextPick};
  }
  if(command==='desktop_browser_delegate')return {origin:'https://example.com',grant:{owner:args.owner,allowActions:true,remainingMs:600000}};
 }},event:{listen:async()=>()=>{}}};`})
 await page.addScriptTag({content:ownedViewModuleTestInput('@xlang/xharness-client-ui-browser')})
 await page.evaluate(()=>{
  const plugin=registration.factory(id=>staticModules[id]??(id==='react'?React:{}));plugin.apply({get:()=>undefined,remote:{$on:()=>()=>{}},effect:fn=>fn(),slots:{inject:(_n,fn)=>fn(),register:()=>{}}});
  window.root=ReactDOM.createRoot(document.getElementById('root'));
  function App(){const[session,setSession]=React.useState('session-one');window.setSession=setSession;return React.createElement(plugin.BrowserPane,{item:{id:'browser:1',kind:'browser',entries:['https://example.com/'],position:0,title:'example'},sessionId:session,open:true,onUpdate:()=>{},onClose:()=>{},onNewBrowser:()=>{}})}root.render(React.createElement(App));
 })
 const start=()=>page.getByRole('button',{name:'选取组件',exact:true}).click()
 await start();await page.waitForFunction(()=>calls.some(c=>c.command==='desktop_browser_pick'&&c.args.request.action==='poll'))
 await page.evaluate(()=>window.nextPick='selected');await page.waitForFunction(()=>received.length===1)
 const result=await page.evaluate(async()=>{
  const files=received[0],bitmap=await createImageBitmap(files[0]);const dimensions=[bitmap.width,bitmap.height];bitmap.close();return {names:files.map(f=>f.name),dimensions,text:await files[1].text()};
 })
 assert.deepEqual(result.names,['selected-component.png','selected-component-context.txt']);assert.deepEqual(result.dimensions,[240,120]);assert.match(result.text,/#primary/);assert.match(result.text,/untrusted/)
 await page.getByRole('status').getByText(/已加入聊天附件/).waitFor();assert.equal(await page.evaluate(()=>calls.some(c=>/prompt|send/.test(c.command))),false,'picking never sends a prompt')
 // Cancellation and session changes reject late evidence instead of attaching
 // into either the old or newly visible chat.
 await page.evaluate(()=>{nextPick='pending';holdPoll=true});await start();await page.waitForFunction(()=>typeof releasePoll==='function')
 await page.evaluate(()=>setSession('session-two'));await page.evaluate(()=>{holdPoll=false;nextPick='selected';releasePoll()});await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>received.length),1)
 await page.evaluate(()=>{nextPick='pending';holdStart=true;releaseStart=null});await start();await page.getByRole('button',{name:'取消选取组件',exact:true}).click();await page.evaluate(()=>{holdStart=false;releaseStart()});await page.waitForFunction(()=>calls.filter(c=>c.command==='desktop_browser_pick'&&c.args.request.action==='cancel').length>=2)
 // No matching receiver: explicit failure; no ghost success and no auto-send.
 await page.evaluate(()=>{stopReceiver();nextPick='selected'});await start();await page.getByRole('alert').getByText(/没有可用的附件输入框/).waitFor();assert.equal(await page.evaluate(()=>received.length),1)
 await page.evaluate(()=>root.unmount());assert.deepEqual(errors,[])
 console.log(engine+': picker UI crop/DPR, draft-only intake, cancel/start/poll races and session ownership passed (mock native IPC)')
}finally{await browser.close()}
