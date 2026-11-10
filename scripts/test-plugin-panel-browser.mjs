// Real opaque iframe + production React bridge, no external plugin/model/files.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
const root=resolve(new URL('../',import.meta.url).pathname)
const require=createRequire(resolve(root,'ui/package.json'))
const deps=resolve(process.env.UI_TEST_DEPS??resolve(root,'scripts/ui-test-deps'))
const pw=createRequire(resolve(deps,'package.json'))('playwright')
const assetSource=readFileSync(resolve(root,'crates/xharness-server/src/plugin_assets.rs'),'utf8')
const policyTemplate=assetSource.match(/let policy\s*=\s*format!\(\s*"([^"]+)"/)?.[1];assert.ok(policyTemplate,'Use the actual carrier CSP, not a hand-maintained weaker fixture')
const cap='a'.repeat(64),path=`/plugin-panel/${cap}/panel.html`
const bundle=require('esbuild').buildSync({stdin:{contents:`import {PluginPanel,openPluginEditor,requestPluginPanelClose,panelDescriptor} from './ui/src/modules/browser/plugin-panel';window.panelApi={PluginPanel,openPluginEditor,requestPluginPanelClose,panelDescriptor}`,resolveDir:root},bundle:true,write:false,format:'iife',jsx:'automatic',external:['react','react/jsx-runtime'],banner:{js:`var require=id=>id==='react'?React:{jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k}),Fragment:React.Fragment};`}}).outputFiles[0].text
const server=createServer((req,res)=>{
 if(req.url===`/plugin-panel/${cap}/boot.js`){res.setHeader('Content-Type','text/javascript');res.setHeader('Access-Control-Allow-Origin','null');res.end('window.moduleLoaded=true');return}
 if(req.url===path){res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',policyTemplate.replaceAll('{sources}',`http://${req.headers.host}/plugin-panel/${cap}/ https://${req.headers.host}/plugin-panel/${cap}/`));res.end(`<script>
window.received=[];window.addEventListener('message',e=>{received.push(e.data);if(e.data.id===1&&e.data.result){parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');parent.postMessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'_editor_poll',arguments:{token:'fixture'}}},'*')}});
try {parent.document;window.parentReadable=true}catch{window.parentReadable=false}
import('./boot.js').then(()=>parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26'}},'*'));
</script>`)}else{res.setHeader('Content-Type','text/html');res.end('<div id="root" style="height:500px"></div>')}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await pw[process.env.UI_TEST_BROWSER??'chromium'].launch({headless:true})
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 for(const f of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(deps,'node_modules',f)})
 await page.addScriptTag({content:bundle})
 await page.evaluate(async({cap,path})=>{
  const descriptor={capability:cap,sessionId:'S',plugin:'wordcraft',title:'WordCraft',source:'file.docx',entry:path}
  window.calls=[];window.fixtureClosed=false;window.busy=true
  window.client={async panelCall(method,args,signal){calls.push({method,args});if(method==='plugins/panelOpen')return{panel:descriptor,initial:{content:[{type:'text',text:'fixture'}]}};if(method==='plugins/panelClose'&&window.busy)throw Error('editor tool is still running');return {content:[],signal:!!signal}}}
  window.root=ReactDOM.createRoot(document.getElementById('root'))
  window.addEventListener('xharness:workspace-open',e=>root.render(React.createElement(panelApi.PluginPanel,{item:e.detail,sessionId:'S',client:window.client})))
  window.addEventListener('xharness:plugin-panel-closed',()=>{window.fixtureClosed=true;root.render(null)})
 },{cap,path})
 page.once('dialog',d=>d.dismiss());await page.evaluate(()=>panelApi.openPluginEditor(client,'S','file.docx'))
 assert.equal(await page.evaluate(()=>calls.length),0,'cancelled launch must not call Host or start a plugin')
 page.once('dialog',d=>d.accept());await page.evaluate(()=>panelApi.openPluginEditor(client,'S','file.docx'))
 assert.equal(await page.evaluate(()=>calls.find(c=>c.method==='plugins/panelOpen').args.launchConfirmed),true)
 await page.waitForFunction(()=>window.calls.some(c=>c.method==='plugins/panelRpc'))
 const frame=page.frames().find(f=>f.url().endsWith('/panel.html'));assert.ok(frame)
 assert.equal(await frame.evaluate(()=>window.moduleLoaded),true,'CSP must allow the bound module in an opaque WebKit frame')
 assert.equal(await frame.evaluate(()=>window.parentReadable),false,'opaque iframe cannot read Host DOM/cookies')
 await frame.waitForFunction(()=>window.received.some(v=>v.method==='ui/notifications/tool-result'))
 const identity=await frame.evaluate(()=>window.identity=crypto.randomUUID())
 await page.evaluate(()=>{document.getElementById('root').style.display='none'})
 await page.waitForTimeout(100)
 await page.evaluate(()=>{document.getElementById('root').style.display='block'})
 assert.equal(await frame.evaluate(()=>window.identity),identity,'hide/show must not reload unsaved editor')
 const before=await page.evaluate(()=>calls.length)
 await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',id:'spoof',method:'tools/call',params:{name:'_editor_reply'}},'*'))
 await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>calls.length),before,'foreign source must not reach Host')
 // Host rejects busy close; the exact iframe and its document survive.
 page.once('dialog',d=>d.accept());await page.evaluate(cap=>panelApi.requestPluginPanelClose(cap),cap)
 await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>window.fixtureClosed),false)
 assert.equal(await frame.evaluate(()=>window.identity),identity)
 await page.evaluate(()=>{window.busy=false});page.once('dialog',d=>d.accept());await page.evaluate(cap=>panelApi.requestPluginPanelClose(cap),cap)
 await page.waitForFunction(()=>window.fixtureClosed);assert.equal(await page.locator('iframe').count(),0)
 assert.deepEqual(errors,[])
 // Bound descriptors, never arbitrary plugin URLs or another session's capability.
 assert.equal(await page.evaluate(({cap,path})=>{let rejected=0;for(const change of [{sessionId:'other'},{entry:'https://evil.example/'},{capability:'bad'},{entry:path.replace(cap,'b'.repeat(64))}]){try{panelApi.panelDescriptor({panel:{capability:cap,sessionId:'S',plugin:'wordcraft',title:'WordCraft',source:'file.docx',entry:path,...change}},'S')}catch{rejected++}}return rejected},{cap,path}),4)
 console.log(`plugin panel ${process.env.UI_TEST_BROWSER??'chromium'}: cancelled/confirmed launch, opaque handshake, tool result, source binding, retention, busy close, confirmed close, descriptor rejection passed`)
}finally{await browser.close();await new Promise(r=>server.close(r))}
