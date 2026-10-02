/** Entire generated graph and genuine platform/Core, using only built-in fixture transport. */
import assert from 'node:assert/strict'
import {readFileSync,existsSync,mkdirSync} from 'node:fs'
import {resolve,sep} from 'node:path'
import {createRequire} from 'node:module'
const implementation=process.env.UI_TEST_IMPL??'source',engine=process.env.UI_TEST_BROWSER??'chromium'
assert.ok(['source','legacy'].includes(implementation));assert.ok(['chromium','webkit'].includes(engine))
const base=resolve(implementation==='source'?'ui/dist':'ui/reference/master-a613970')
const deps=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const require=createRequire(resolve(deps,'package.json')),browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:1280,height:820},colorScheme:'light'}),errors=[],failed=[],requests=[],consoleErrors=[]
 page.on('pageerror',error=>errors.push(error.stack??error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text())});page.on('requestfailed',request=>failed.push({url:request.url(),error:request.failure()?.errorText}))
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());requests.push(url.pathname)
  if(url.hostname!=='127.0.0.1')return route.abort('blockedbyclient')
  const local=resolve(base,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname))
  if(!local.startsWith(base+sep)||!existsSync(local))return route.fulfill({status:404,body:'fixture asset missing'})
  const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm'}
  const extension=local.match(/\.[^./]+$/)?.[0]
  return route.fulfill({body:readFileSync(local),contentType:types[extension]??'application/octet-stream'})
 })
 await page.goto('http://127.0.0.1:39187/?fixture=1')
 try{await page.waitForFunction(()=>document.querySelector('textarea,[contenteditable="true"]')||document.body.innerText.includes('Failed to load plugins'),{},{timeout:60000})}catch(error){console.error(JSON.stringify({engine,implementation,errors,consoleErrors,failed,requests,text:await page.locator('body').innerText()}));throw error}
 if(errors.length)console.error(JSON.stringify({errors,consoleErrors,text:await page.locator('body').innerText()}))
 if(process.env.UI_BOOT_RECEIPT_DIR){
  await page.evaluate(()=>document.fonts.ready);mkdirSync(process.env.UI_BOOT_RECEIPT_DIR,{recursive:true});
  await page.screenshot({path:resolve(process.env.UI_BOOT_RECEIPT_DIR,engine+'-'+implementation+'-full-boot.png'),animations:'disabled',caret:'hide'})
 }
 const early=await page.evaluate(()=>({text:document.body.innerText,buttons:document.querySelectorAll('button').length,inputs:document.querySelectorAll('textarea,[contenteditable="true"]').length}))
 assert.deepEqual(errors,[],'whole boot must not fail factory registration or real Core service injection')
 assert.ok(early.buttons>5,'actual workspace and conversation controls mounted')
 assert.ok(!/Failed to load plugins|Failed to start|缺少.*模块/.test(early.text),'no boot error screen')
 assert.ok(requests.some(path=>path.includes('/plugins/@xharness/dsh-client-connection/')),'built-in fixture uses actual connection module')
 assert.ok(!requests.some(path=>path.startsWith('/api/')),'isolated fixture never connects to a real Host')
 await page.getByRole('button',{name:'Settings',exact:true}).click()
 await page.getByRole('button',{name:'General',exact:true}).waitFor()
 await page.getByRole('button',{name:'Models',exact:true}).click()
 await page.getByRole('button',{name:'Add provider',exact:true}).waitFor()
 await page.getByRole('button',{name:'Add a custom provider',exact:true}).waitFor()
 await page.getByRole('button',{name:'Close',exact:true}).click()
 await page.getByRole('button',{name:/Select model, current/}).click()

 await page.locator('button').filter({hasText:/^Effort\s*High$/}).waitFor()
 await page.locator('button').filter({hasText:/^上下文容量\s*未知$/}).waitFor()
 await page.locator('button').filter({hasText:/^Effort\s*High$/}).click()
 for(const name of ['Off','High','Max']) await page.locator('button').filter({hasText:new RegExp('^'+name+'$')}).waitFor()
 await page.locator('button').filter({hasText:/^Off$/}).click()
 await page.getByRole('button',{name:/Select model, current.*reasoning effort Off/}).waitFor()
 // Built-in fixture has no live HMR SSE server; WebKit may cancel that
 // optional connection after its isolated 404. Do not ignore static failures.
 const staticFailures=failed.filter(row=>new URL(row.url).pathname!=='/plugins/events')
 assert.deepEqual(staticFailures,[],'all full graph static requests complete')

 assert.deepEqual(errors,[],'navigation on the genuine full graph must not throw')
 console.log(JSON.stringify({engine,implementation,fullGraph:true,fixtureTransport:true,settingsProviders:true,modelEffortAndContextControls:true,effortChange:true,buttons:early.buttons,inputs:early.inputs,errors,staticFailures,fixtureHmrDisconnects:failed.filter(row=>new URL(row.url).pathname==='/plugins/events').length,text:early.text.slice(0,1000),loadedPlugins:requests.filter(path=>path.startsWith('/plugins/')&&path.endsWith('/client.js')).length}))
}finally{await browser.close()}
