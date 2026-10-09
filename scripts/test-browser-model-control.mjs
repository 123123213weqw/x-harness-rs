import {installShellSessionsFixture} from './fixtures/shell-navigation-browser.mjs'
// Real AppFrame/BrowserPane; fake ONLY the Tauri transport. Not a native input
// or engine acceptance test. Never equate Playwright WebKit with WKWebView.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
const deps=resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require=createRequire(resolve(deps,'package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:1400,height:800}})
 const errors=[]
 page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot'){errors.push(e.message);console.error('PAGE',e.message)}})
 await installOwnedViewHtml(page,'canonical','<html><body><div id="root" style="position:fixed;inset:0"></div></body></html>')
 await page.addScriptTag({content:`
 window.registrations={};window.__ModuleLoader__={load:x=>registrations[x.id]=x};
 window.calls=[];window.nativeTabs=new Map();window.nativeListeners=new Map();window.activeTab=null;window.restoreDone=false;
 window.emitNative=(event,payload)=>{for(const fn of nativeListeners.get(event)??[])fn({event,payload,id:1})};
 window.__TAURI__={core:{invoke:async(command,args={})=>{
   calls.push({command,args});
   if(command==='desktop_browser_restore'){restoreDone=true;return '{}'}
   if(command==='desktop_browser_activate'){activeTab=args.tabId;return nativeTabs.has(args.tabId)}
   if(command==='desktop_browser_page_state')return {...nativeTabs.get(args.tabId)};
   if(command==='desktop_browser_close'){nativeTabs.delete(args.tabId);return}
   if(command==='desktop_browser_navigate'){
     const url=window.redirectNext??args.url;window.redirectNext=undefined;
     nativeTabs.set(args.tabId,{url,loaded:true});
     // Regression: Finished arrives BEFORE the navigate promise resolves.
     emitNative('xharness-browser-event',{tabId:args.tabId,kind:'loading',value:url});
     emitNative('xharness-browser-event',{tabId:args.tabId,kind:'url',value:url});
     emitNative('xharness-browser-event',{tabId:args.tabId,kind:'loaded',value:url});
     // A duplicate URL is not a new load. Previously this poisoned readiness.
     emitNative('xharness-browser-event',{tabId:args.tabId,kind:'url',value:url});return;
   }
   if(command==='desktop_browser_delegate'){
     if(new URL(nativeTabs.get(args.tabId).url).origin!==args.expectedOrigin)throw Error('browser origin changed; synchronize the visible page again');
     return {origin:args.expectedOrigin,grant:{owner:args.owner,allowActions:true,remainingMs:600000}};
   }
   if(command==='desktop_browser_control_reply')return args.reply.status==='ready'&&nativeTabs.get(args.reply.tab_id)?.loaded===true;
 }},event:{listen:async(event,fn)=>{const set=nativeListeners.get(event)??new Set();set.add(fn);nativeListeners.set(event,set);return()=>set.delete(fn)}}};
 `})
 for(const id of ['@xharness/dsh-client-ui-layout','@xlang/xharness-client-ui-browser','@xharness/dsh-client-runtime'])await page.addScriptTag({content:ownedViewModuleTestInput(id)})
  await installShellSessionsFixture(page)
 await page.evaluate(()=>{
   const runtime=registrations['@xharness/dsh-client-runtime'].factory(id=>staticModules[id])
   const load=id=>id==='@xharness/dsh-client-runtime/client'?runtime:staticModules[id]
   const layout=registrations['@xharness/dsh-client-ui-layout'].factory(load)
   const browser=registrations['@xlang/xharness-client-ui-browser'].factory(load)
   browser.apply({effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:()=>{}}})
    const shellSessions=createShellSessionsFixture({current:'chat-a',ids:['chat-a'],byId:{'chat-a':{blank:false}}})
   let AppFrame,definition
   layout.apply({get:name=>name==='sessions'?shellSessions:undefined,effect:(fn,label)=>{if(label.includes('service'))fn()},reflect:{provide:()=>()=>{}},slots:{register:(spec,view)=>{AppFrame=view;definition=spec;return()=>{}}}})
   const store=definition.store().create();const injected=definition.inject(store.actions)
   function App(){
     const [owner,setOwner]=React.useState('chat-a');window.selectOwner=id=>{shellSessions.update({current:id,ids:[id],byId:{[id]:{blank:false}}});setOwner(id)}
     return React.createElement(AppFrame,{...injected,useStore:s=>s(React.useSyncExternalStore(store.subscribe,store.getSnapshot)),useSessions:s=>s({current:owner,byId:{}}),actions:store.actions,
      renderSlot:(name,props)=>name==='workspace.item'?React.createElement(browser.BrowserPane,props):null})
   }
   window.root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(App))
 })
 await page.waitForFunction(()=>restoreDone&&nativeListeners.get('xharness-browser-control-open')?.size===1&&calls.some(c=>c.command==='desktop_browser_persist'))
 assert.equal(await page.locator('.xhbrowser-pane').count(),0)
 const requestId='a'.repeat(32),tabId=`browser:${requestId}`
 await page.evaluate(requestId=>emitNative('xharness-browser-control-open',{requestId,owner:'chat-a',url:'https://example.com/'}),requestId)
 await page.waitForFunction(id=>calls.some(c=>c.command==='desktop_browser_control_reply'&&c.args.requestId===id&&c.args.reply.status==='ready'),requestId)
 assert.equal(await page.locator('[data-xhworkspace-open]').count(),1,'model open expands sidebar from zero tabs')
 const calls=await page.evaluate(()=>window.calls)
 const index=command=>calls.findIndex(c=>c.command===command)
 assert(index('desktop_browser_bounds')<index('desktop_browser_navigate'))
 assert(index('desktop_browser_navigate')<index('desktop_browser_delegate'))
 assert(index('desktop_browser_delegate')<index('desktop_browser_control_reply'))
 assert.equal(await page.getByRole('textbox',{name:'网址'}).inputValue(),'https://example.com/')
 // Completed request cannot be replayed or deleted by a late cancel.
 await page.evaluate(requestId=>emitNative('xharness-browser-control-open',{requestId,owner:'chat-a',url:'https://example.com/'}),requestId)
 await page.waitForTimeout(50)
 assert.equal(await page.getByRole('tab').count(),1)
 await page.evaluate(requestId=>emitNative('xharness-browser-control-cancel',requestId),requestId)
 assert.equal(await page.getByRole('textbox',{name:'网址'}).count(),1)
 // A frame-agnostic policy hint uses the native top-level URL, not its source.
 await page.evaluate(tabId=>emitNative('xharness-browser-event',{tabId,kind:'navigation-policy',value:'https://iframe.example/'}),tabId)
 await page.waitForFunction(()=>calls.some(c=>c.command==='desktop_browser_page_state'))
 assert.equal(await page.getByRole('textbox',{name:'网址'}).inputValue(),'https://example.com/')
 // Same-document location changes remain supported without a Finished event.
 await page.evaluate(tabId=>{
   nativeTabs.get(tabId).url='https://example.com/#section'
   emitNative('xharness-browser-event',{tabId,kind:'navigation-policy',value:''})
 },tabId)
 await page.waitForFunction(()=>document.querySelector('.xhbrowser-address-form input')?.value==='https://example.com/#section')
 await page.evaluate(tabId=>{
   nativeTabs.get(tabId).url='https://example.com/'
   emitNative('xharness-browser-event',{tabId,kind:'navigation-policy',value:''})
 },tabId)
 await page.waitForFunction(()=>document.querySelector('.xhbrowser-address-form input')?.value==='https://example.com/')
 // A delayed native sample must not overwrite a newer top-level load event.
 await page.evaluate(tabId=>{
   const invoke=__TAURI__.core.invoke
   __TAURI__.core.invoke=(command,args)=>{
     if(command!=='desktop_browser_page_state')return invoke(command,args)
     __TAURI__.core.invoke=invoke
     return new Promise(resolve=>{window.releasePageSample=()=>resolve({url:'https://old.example/',loaded:false})})
   }
   emitNative('xharness-browser-event',{tabId,kind:'navigation-policy',value:''})
 },tabId)
 await page.waitForFunction(()=>typeof window.releasePageSample==='function')
 await page.evaluate(tabId=>{
   emitNative('xharness-browser-event',{tabId,kind:'url',value:'https://example.com/'})
   emitNative('xharness-browser-event',{tabId,kind:'loaded',value:'https://example.com/'})
   releasePageSample()
 },tabId)
 await page.waitForTimeout(100)
 assert.equal(await page.getByRole('textbox',{name:'网址'}).inputValue(),'https://example.com/')
 // Committed top-level redirect is synchronized before exact-origin binding.
 const redirected='f'.repeat(32)
 await page.evaluate(requestId=>{
   window.redirectNext='https://final.example/path'
   emitNative('xharness-browser-control-open',{requestId,owner:'chat-a',url:'https://start.example/'})
 },redirected)
 await page.waitForFunction(id=>calls.some(c=>c.command==='desktop_browser_control_reply'&&c.args.requestId===id&&c.args.reply.status==='ready'),redirected)
 // Native readiness is not a React paint receipt. Wait for the controlled
 // input's commit, then keep the exact URL and origin assertions below.
 await page.waitForFunction(()=>document.querySelector('.xhbrowser-address-form input')?.value==='https://final.example/path',{},{timeout:5000})
 assert.equal(await page.getByRole('textbox',{name:'网址'}).inputValue(),'https://final.example/path')
 assert.equal(await page.evaluate(id=>calls.filter(c=>c.command==='desktop_browser_delegate'&&c.args.tabId==='browser:'+id).at(-1).args.expectedOrigin,redirected),'https://final.example')
 await page.getByRole('button',{name:'关闭 final.example',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('.xhbrowser-address-form input')?.value==='https://example.com/')
 await page.evaluate(()=>selectOwner('chat-b'))
 await page.waitForFunction(()=>!document.querySelector('.xhbrowser-pane'))
 const other='b'.repeat(32)
 await page.evaluate(requestId=>emitNative('xharness-browser-control-open',{requestId,owner:'chat-a',url:'https://other.example/'}),other)
 await page.waitForFunction(id=>calls.some(c=>c.command==='desktop_browser_control_reply'&&c.args.requestId===id&&c.args.reply.status==='failed'),other)
 assert.equal(await page.locator('.xhbrowser-pane').count(),0,'background owner cannot steal current chat')
 assert.equal(await page.evaluate(id=>calls.some(c=>c.command==='desktop_browser_navigate'&&c.args.tabId===`browser:${id}`),other),false)
 // Malformed scheme/credentials and request IDs do not schedule navigation.
 const before=await page.evaluate(()=>calls.length)
 for(const url of ['javascript:alert(1)','file:///etc/passwd','https://user:pass@example.com/'])await page.evaluate(url=>emitNative('xharness-browser-control-open',{requestId:'c'.repeat(32),owner:'chat-b',url}),url)
 await page.waitForTimeout(100)
 assert.equal(await page.evaluate(()=>calls.length),before)
 // A cancellation delivered before its open event leaves no ghost tab.
 await page.evaluate(()=>{
   emitNative('xharness-browser-control-cancel','e'.repeat(32))
   emitNative('xharness-browser-control-open',{requestId:'e'.repeat(32),owner:'chat-b',url:'https://late.example/'})
 })
 await page.waitForTimeout(50)
 assert.equal(await page.locator('.xhbrowser-pane').count(),0)
 // In-flight open cancellation closes only that provisional tab, not history.
 await page.evaluate(()=>{
   const invoke=__TAURI__.core.invoke
   __TAURI__.core.invoke=(command,args)=>command==='desktop_browser_navigate'?new Promise(resolve=>{window.releaseNavigation=()=>invoke(command,args).then(resolve)}):invoke(command,args)
   emitNative('xharness-browser-control-open',{requestId:'d'.repeat(32),owner:'chat-b',url:'https://pending.example/'})
 })
 await page.waitForFunction(()=>typeof window.releaseNavigation==='function')
 await page.evaluate(()=>emitNative('xharness-browser-control-cancel','d'.repeat(32)))
 await page.waitForFunction(()=>!document.querySelector('.xhbrowser-pane'))
 await page.evaluate(()=>releaseNavigation())
 await page.waitForTimeout(100)
 assert.equal(await page.evaluate(()=>calls.some(c=>c.command==='desktop_browser_control_reply'&&c.args.requestId==='d'.repeat(32)&&c.args.reply.status==='ready')),false)
 assert.equal(await page.evaluate(()=>nativeTabs.has('browser:'+ 'd'.repeat(32))),false,'late native create must be closed after cancellation')
 await page.evaluate(()=>selectOwner('chat-a'))
 await page.getByRole('textbox',{name:'网址'}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'网址'}).inputValue(),'https://example.com/')
 await page.evaluate(()=>root.unmount())
 assert.deepEqual(errors,[])
 console.log(engine+': zero-tab → sidebar → load-before-promise → owner binding → ready; background/late/cancel/schema guards passed (mock transport)')
}finally{await browser.close()}
