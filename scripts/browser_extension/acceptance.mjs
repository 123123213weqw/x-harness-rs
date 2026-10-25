// Real isolated Chromium extension + native messaging + MCP; never touches user profiles or live sites.
import assert from 'node:assert/strict'
import{createServer}from'node:http'
import{spawn}from'node:child_process'
import{createInterface}from'node:readline'
import{createRequire}from'node:module'
import{resolve,join}from'node:path'
import{mkdtemp,mkdir,cp,writeFile,readFile,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{install}from'../../plugins/browser-extension/scripts/install-native.mjs'
if(process.env.XHARNESS_BROWSER_EXTENSION_TEST_SERVER!=='1'||process.platform!=='linux')throw Error('Run in the isolated Linux server checkout only')
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'plugins/browser-use','package.json'))
const {chromium}=require('playwright'),temporary=await mkdtemp(join(tmpdir(),'xh-extension-real-')),home=join(temporary,'home'),xdg=join(home,'.config'),profile=join(temporary,'profile'),extension=join(temporary,'extension')
await mkdir(home,{recursive:true,mode:0o700});await cp('plugins/browser-extension/dist',extension,{recursive:true})
let foreignRequests=0,sessionRetained=false
const foreign=createServer((_req,res)=>{foreignRequests++;res.end('Forbidden origin')});foreign.listen(0,'127.0.0.1');await new Promise(r=>foreign.once('listening',r))
const foreignOrigin=`http://127.0.0.1:${foreign.address().port}`
const server=createServer((req,res)=>{
 res.setHeader('Content-Type','text/html; charset=utf-8')
 res.setHeader('Set-Cookie','fixture_session=retained; HttpOnly; SameSite=Lax; Path=/')
 if(req.url==='/commit'){sessionRetained=req.headers.cookie?.includes('fixture_session=retained')===true;return res.end('committed')}
 if(req.url==='/foreground')return res.end(`<title>Foreground sentinel</title><h1>Keep working here</h1><script>window.foregroundKeys=[];addEventListener('keydown',e=>foregroundKeys.push(e.key))</script>`)
 res.end(`<!doctype html><meta charset="utf-8"><title>Background fixture</title><h1>Extension acceptance</h1><label>Report<input aria-label="Report" value="old"></label><input type="password" value="NEVER_RETURN_PASSWORD"><button id="increment">Increment</button><button id="stale">Stale target</button><p id="state">0</p><div hidden>NEVER_RETURN_HIDDEN</div><script>window.count=0;window.trusted=[];window.keys=[];document.getElementById('increment').addEventListener('click',e=>{window.trusted.push(e.isTrusted);fetch('/commit',{method:'POST'});document.getElementById('state').textContent=String(++window.count)});document.querySelector('input').addEventListener('keydown',e=>window.keys.push({key:e.key,trusted:e.isTrusted}));document.querySelector('input').addEventListener('input',e=>window.trusted.push(e.isTrusted))</script>`)
});server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
const origin=`http://xharness-extension-fixture.test:${server.address().port}`
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'))
// Test installation pregrants ONLY the controlled loopback fixture origin. Production remains optional-host-permissions.
manifest.host_permissions=[origin+'/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest))
const native=await install({binary:resolve(process.env.XHARNESS_BROWSER_EXTENSION_HOST??'target/debug/xharness-browser-extension-host'),browser:'chromium',register:true,home,xdg})
// Playwright's branded Chrome for Testing searches its own official per-user registration directory.
const testingManifest=join(xdg,'google-chrome-for-testing','NativeMessagingHosts','com.xharness.browser_bridge.json');await mkdir(resolve(testingManifest,'..'),{recursive:true});await cp(native.manifestPath,testingManifest)
await mkdir(join(profile,'NativeMessagingHosts'),{recursive:true});await cp(native.manifestPath,join(profile,'NativeMessagingHosts','com.xharness.browser_bridge.json'))
function mcp(){
 const child=spawn(process.execPath,[resolve('plugins/browser-extension/dist/native/mcp.js')],{env:{...process.env,HOME:home,USERPROFILE:home}}),pending=new Map();let seq=0,stderr=''
 child.stderr.on('data',value=>stderr+=value)
 createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line);pending.get(reply.id)?.(reply);pending.delete(reply.id)})
 return {child,call(action){return new Promise((resolve,reject)=>{const id=String(++seq),timer=setTimeout(()=>reject(Error(stderr||'MCP call timed out')),25000);pending.set(id,value=>{clearTimeout(timer);if(value.error)reject(Error(value.error.message));else resolve(value.result)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'browser',arguments:action}})+'\n')})},async close(){if(child.exitCode!==null)return;child.stdin.end();await new Promise(r=>child.once('exit',r))}}
}
const a=mcp(),b=mcp();let context,aClosed=false
const checks=[],check=(name)=>{checks.push(name);console.log('PASS',name)}
const unpack=result=>{assert.equal(result.isError,false,JSON.stringify(result));return JSON.parse(result.content[0].text)}
try{
 const unpaired=unpack(await a.call({action:'status'}));assert.equal(unpaired.connected,false);check('unpaired-has-code-no-browser-authority')
 context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,env:{...process.env,HOME:home,XDG_CONFIG_HOME:xdg},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-proxy-server','--host-resolver-rules=MAP xharness-extension-fixture.test 127.0.0.1']})
 let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker')
 const extensionId=worker.url().split('/')[2];assert.equal(extensionId,native.extensionId)
 const background=await context.newPage();await background.goto(origin)
 const foreground=await context.newPage();await foreground.goto(origin+'/foreground')
 const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`)
 const pageErrors=[];popup.on('pageerror',error=>pageErrors.push(error.message))
 await popup.getByRole('button',{name:'连接 XHarness',exact:true}).click()
 try{await popup.locator('#status[data-connected="true"]').waitFor({timeout:12000})}catch(error){console.log('Popup error:',await popup.locator('#error').textContent());throw error}
 await popup.locator('#client option').filter({hasText:unpaired.pairCode}).waitFor({state:'attached'})
 const state=await popup.evaluate(()=>chrome.runtime.sendMessage({action:'state'})),target=state.tabs.find(tab=>tab.title==='Background fixture').id
 const grant=async(code)=>{await popup.locator('#client').selectOption({label:'配对码 '+code});await popup.locator('#tab').selectOption(String(target));await popup.getByRole('button',{name:'授权这个标签页',exact:true}).click();await popup.locator('#authorized').getByText('已授权 · '+origin,{exact:true}).waitFor()}
 await grant(unpaired.pairCode);await mkdir('dist/browser-extension-evidence',{recursive:true});await popup.locator('body').screenshot({path:'dist/browser-extension-evidence/popup-connected.png'});check('real-popup-native-messaging-explicit-tab-grant')
 // Playwright normally forces every page to virtually focused/visible. Disable
 // that test-driver emulation before validating a genuinely hidden real tab.
 const backgroundSession=await context.newCDPSession(background)
 await backgroundSession.send('Emulation.setFocusEmulationEnabled',{enabled:false})
 await foreground.bringToFront()
 await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});const sentinel=tabs.find(tab=>tab.title==='Foreground sentinel');await chrome.tabs.update(sentinel.id,{active:true})})
 const beforeActive=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({active:true,currentWindow:true});return tabs[0].id})
 assert.notEqual(beforeActive,target)
 const rendererVisibility={before:await background.evaluate(()=>document.visibilityState)}
 assert.equal(await worker.evaluate(async target=>(await chrome.tabs.get(target)).active,target),false)
 assert.equal(await background.evaluate(()=>isSecureContext),false);check('HTTP-page-does-not-require-web-crypto-randomUUID')
 const observed=unpack(await a.call({action:'observe',tabId:target}));assert.equal(JSON.stringify(observed).includes('NEVER_RETURN_PASSWORD'),false);assert.equal(JSON.stringify(observed).includes('NEVER_RETURN_HIDDEN'),false);assert.ok(Buffer.byteLength(JSON.stringify(observed))<=16000)
 const field=observed.nodes.find(node=>node.name==='Report');assert.ok(field)
 unpack(await a.call({action:'fill',tabId:target,observationId:observed.observationId,ref:field.ref,text:'后台 中文 😀'}));assert.equal(await background.locator('input').first().inputValue(),'后台 中文 😀')
 unpack(await a.call({action:'press',tabId:target,key:'Enter'}));assert.deepEqual(await background.evaluate(()=>window.keys),[{key:'Enter',trusted:true}]);assert.deepEqual(await foreground.evaluate(()=>window.foregroundKeys),[]);check('browser-owned-keypress-has-trusted-events')
 const next=unpack(await a.call({action:'observe',tabId:target})),button=next.nodes.find(node=>node.name==='Increment')
 unpack(await a.call({action:'click',tabId:target,observationId:next.observationId,ref:button.ref}));assert.equal(await background.locator('#state').textContent(),'1')
 assert.deepEqual(await background.evaluate(()=>window.trusted),[true,true])
 for(let i=0;i<50&&!sessionRetained;i++)await new Promise(resolve=>setTimeout(resolve,20))
 assert.equal(sessionRetained,true);check('existing-tab-httpOnly-session-retained-without-cookie-transfer')
 const afterActive=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({active:true,currentWindow:true});return tabs[0].id});assert.equal(afterActive,beforeActive);assert.equal(await worker.evaluate(async target=>(await chrome.tabs.get(target)).active,target),false);rendererVisibility.after=await background.evaluate(()=>document.visibilityState);check('trusted-fill-click-in-inactive-tab-without-foreground-steal')
 assert.equal((await a.call({action:'click',tabId:target,observationId:next.observationId,ref:button.ref})).isError,true);assert.equal(await background.locator('#state').textContent(),'1');check('one-shot-ref-not-replayed')
 const stale=unpack(await a.call({action:'observe',tabId:target})),staleRef=stale.nodes.find(node=>node.name==='Stale target')
 await background.evaluate(()=>{const old=document.getElementById('stale');old.replaceWith(old.cloneNode(true))})
 assert.equal((await a.call({action:'click',tabId:target,observationId:stale.observationId,ref:staleRef.ref})).isError,true);check('same-looking-dom-replacement-denied')
 const expires=unpack(await a.call({action:'observe',tabId:target})),expiring=expires.nodes.find(node=>node.name==='Increment')
 await new Promise(resolve=>setTimeout(resolve,31000))
 assert.equal((await a.call({action:'click',tabId:target,observationId:expires.observationId,ref:expiring.ref})).isError,true)
 assert.equal(unpack(await a.call({action:'status'})).connected,true);check('reference-TTL-and-live-extension-after-worker-idle-window')
 await background.evaluate(()=>{const large=document.createElement('p');large.id='large';large.textContent='中文😀'.repeat(15000);document.body.append(large)})
 const large=unpack(await a.call({action:'observe',tabId:target}));assert.ok(Buffer.byteLength(JSON.stringify(large))<=16000);assert.equal(large.truncated,true)
 await background.locator('#large').evaluate(element=>element.remove());check('large-CJK-observation-has-hard-UTF8-budget')
 assert.equal((await b.call({action:'observe',tabId:target})).isError,true);check('second-client-cannot-read-owned-tab')
 const shot=await a.call({action:'screenshot',tabId:target});unpack(shot);const image=shot.content.find(block=>block.type==='image');assert.ok(image);assert.equal(image.mimeType,'image/png')
 const png=Buffer.from(image.data,'base64');assert.equal(png.subarray(1,4).toString(),'PNG');assert.ok(png.length<=2097152);assert.equal(await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({active:true,currentWindow:true});return tabs[0].id}),beforeActive);check('background-CDP-screenshot-is-real-MCP-image')
 const navigated=unpack(await a.call({action:'navigate',tabId:target,url:origin+'/next'}));assert.equal(navigated.ready,true);assert.equal(background.url(),origin+'/next');check('same-origin-navigation-waits-for-committed-ready-loader')
 assert.equal((await a.call({action:'navigate',tabId:target,url:foreignOrigin+'/denied'})).isError,true);assert.equal(foreignRequests,0);check('cross-origin-command-denied-before-navigation')
 await popup.getByRole('button',{name:'停止全部操作',exact:true}).click();await popup.locator('#authorized').getByText('尚未授权标签页',{exact:true}).waitFor()
 assert.equal((await a.call({action:'press',tabId:target,key:'Enter'})).isError,true);check('stop-revokes-before-next-effect')
 await grant(unpaired.pairCode)
 await background.goto(foreignOrigin+'/manual-navigation')
 assert.equal((await a.call({action:'observe',tabId:target})).isError,true);check('manual-origin-change-requires-fresh-authorization')
 await background.goto(origin);await grant(unpaired.pairCode)
 await a.close();aClosed=true;await popup.locator('#authorized').getByText('尚未授权标签页',{exact:true}).waitFor();check('client-process-exit-revokes-its-tab')
 const second=unpack(await b.call({action:'status'}));await grant(second.pairCode)
 await popup.getByRole('button',{name:'断开',exact:true}).click();await popup.locator('#authorized').getByText('尚未授权标签页',{exact:true}).waitFor()
 assert.equal((await b.call({action:'press',tabId:target,key:'Enter'})).isError,true);check('disconnect-revokes-and-never-replays')
 await mkdir('dist/browser-extension-evidence',{recursive:true});await writeFile('dist/browser-extension-evidence/background-page.png',png);await popup.screenshot({path:'dist/browser-extension-evidence/popup.png'})
 assert.deepEqual(pageErrors,[])
 await writeFile('dist/browser-extension-evidence/acceptance.json',JSON.stringify({passed:true,checks,productionPermissionPromptTested:false,isolatedNativeMessaging:true,realBrowser:true,rendererVisibility,backgroundDefinition:'Chrome tab active=false and foreground tab unchanged; not a document.hidden proxy',platform:process.platform},null,2)+'\n')
 console.log(JSON.stringify({passed:true,checks:checks.length,platform:process.platform}))
}finally{await context?.close();if(!aClosed)await a.close();await b.close();server.close();foreign.close();await rm(temporary,{recursive:true,force:true})}
