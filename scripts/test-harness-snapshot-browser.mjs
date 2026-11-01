import {fixtureUiRoot} from './fixtures/ui-fixture-build.mjs'
/** Genuine generated graph. Only the built-in Host fixture transport is
 * enriched with request/header events and scope-bound snapshot responses. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,existsSync,mkdirSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
const engine=process.env.UI_TEST_BROWSER??'chromium'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const base=fixtureUiRoot(), browser=await require('playwright')[engine].launch({headless:true})
const tools=[{name:'fixture_read',description:'Read archived request content',parameters:{type:'object',properties:{path:{type:'string'}}}},{name:'fixture_write',description:'Write with archived configuration',parameters:{type:'object'}}]
const archived={harnessSnapshot:{kind:'archive',version:1,sha256:'fixture'},auditSnapshot:{kind:'omitted',reason:'capture_disabled'}}
const headers=[
 {model:'fixture-model',options:{...archived,snapshotOnDemand:true,toolCount:2}},
 {system:'',tools:[],options:archived},
 {tools:[],options:{harnessSnapshot:{kind:'omitted',reason:'archive_failed'},auditSnapshot:{kind:'omitted',reason:'capture_disabled'},toolCount:18}},
 {system:'Archived independent Harness prompt',tools,options:archived},
]
let reads=[],mismatch=true
try{
 const page=await browser.newPage({viewport:{width:1280,height:900},locale:'en-US'}),errors=[],paths=[]
 page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());paths.push(url.pathname)
  if(url.pathname==='/api/session.requestSnapshot'){
   const request=route.request().postDataJSON(),payload=request.payload;reads.push(payload)
   assert.equal(payload.scope,'harness');assert.equal(payload.sessionId,'fx-alpha')
   const header={system:'Hydrated Harness prompt with diagnostics disabled',tools,options:archived}
   return route.fulfill({json:{type:'server-response',rpcId:request.rpcId,result:{ok:true,value:{sessionId:mismatch?'wrong-session':payload.sessionId,seq:payload.seq,header}}}})
  }
  if(url.hostname!=='127.0.0.1')return route.abort('blockedbyclient')
  const file=resolve(base,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname))
  if(!file.startsWith(base+sep)||!existsSync(file))return route.fulfill({status:404,body:'fixture asset missing'})
  let body=readFileSync(file)
  if(url.pathname==='/plugins/@xharness/dsh-client-connection/client.js'){
   const text=body.toString(),marker="const logs = new Map([[sid('fx-alpha'), buildAlphaLog()]]);"
   assert.equal(text.split(marker).length,2,'exact isolated request-header fixture seam')
   body=Buffer.from(text.replace(marker,marker+`\nwindow.harnessFixtureSeqs=[];for(const header of ${JSON.stringify(headers)}){const log=logs.get(sid('fx-alpha')),seq=log.length;window.harnessFixtureSeqs.push(seq);log.push({seq,time:Date.now(),type:'request/header',data:{reason:'initial',header}});}`))
  }
  const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm'}
  return route.fulfill({body,contentType:types[extname(file)]??'application/octet-stream'})
 })
 await page.goto('http://127.0.0.1:39189/?fixture=1')
 await page.getByText('Fixture 历史会话',{exact:true}).waitFor({timeout:60000})
 await page.locator('[data-xh-startup-exit]').waitFor({state:'detached'})
 await page.getByText('Fixture 历史会话',{exact:true}).click()
 assert.equal(reads.length,0,'Chat does not eagerly hydrate request archives')
 await page.getByRole('tab',{name:'Harness',exact:true}).click()
 const panel=page.locator('.xhctx-harness-root');await panel.waitFor()
 const collapse=page.getByRole('button',{name:'Collapse the question card',exact:true})
 if(await collapse.count()>0)await collapse.click()
 await panel.getByText('Archived independent Harness prompt',{exact:true}).waitFor()
 assert.equal(reads.length,0,'captured inline Harness snapshot is independent of disabled full diagnostics')
 assert.equal(await panel.locator('.xhctx-registry-tool').count(),2)
 const search=panel.getByRole('searchbox',{name:'Search tools',exact:true})
 await search.fill('WRITE');assert.equal(await panel.locator('.xhctx-registry-tool').count(),1)
 const disclosure=panel.locator('summary');await disclosure.focus();await disclosure.press('Enter')
 assert.equal(await panel.locator('.xhctx-registry-tool').getAttribute('open'),'')
 await search.fill('')
 const seqs=await page.evaluate(()=>window.harnessFixtureSeqs)
 const select=panel.getByRole('combobox',{name:'Select request',exact:true})
 await select.selectOption(String(seqs[1]))
 await panel.getByText('This request has no system prompt.',{exact:true}).waitFor()
 await panel.getByText('This request has no tools.',{exact:true}).waitFor()
 assert.equal(await panel.getByText('0 tools',{exact:true}).count(),1,'a captured empty registry is a real zero')
 assert.equal(await panel.getByText(/full diagnostics were disabled/).count(),0)
 await select.selectOption(String(seqs[2]))
 assert.equal(await panel.getByText('Not recorded; the Harness snapshot could not be saved for this request.',{exact:true}).count(),2)
 await panel.getByText('18 tools',{exact:true}).waitFor()
 assert.equal(await panel.getByText('0 tools',{exact:true}).count(),0,'save failure is not fabricated empty content')
 await select.selectOption(String(seqs[0]))
 await panel.getByRole('alert').waitFor()
 assert.equal(await panel.getByText('Hydrated Harness prompt with diagnostics disabled',{exact:true}).count(),0,'scope identity mismatch cannot leak a snapshot')
 assert.equal(await panel.getByText('0 tools',{exact:true}).count(),0,'loading/error is not a fabricated zero')
 mismatch=false;await panel.getByRole('button',{name:'Retry',exact:true}).click()
 await panel.getByText('Hydrated Harness prompt with diagnostics disabled',{exact:true}).waitFor()
 assert.equal(await panel.locator('.xhctx-registry-tool').count(),2)
 assert.deepEqual(reads,[{sessionId:'fx-alpha',seq:seqs[0],scope:'harness'},{sessionId:'fx-alpha',seq:seqs[0],scope:'harness'}],'hydrate only the selected request, on demand, with an explicit Harness scope')
 const evidence=resolve(process.env.UI_HARNESS_RECEIPT_DIR??'dist/regression/harness-snapshot');mkdirSync(evidence,{recursive:true})
 for(const dark of [false,true]){
  await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
  await page.screenshot({path:resolve(evidence,`${engine}-${dark?'dark':'light'}.png`),animations:'disabled'})
 }
 await page.setViewportSize({width:390,height:780})
 await page.waitForFunction(()=>{const panel=document.querySelector('.xhctx-harness-root');return panel&&panel.scrollWidth-panel.clientWidth<2})
 await page.screenshot({path:resolve(evidence,`${engine}-narrow.png`),animations:'disabled'})
 await page.getByRole('tab',{name:'Chat',exact:true}).click()
 assert.ok(await page.locator('textarea,[contenteditable=true]').count()>0,'inspector preserves the genuine chat composer')
 assert.equal(paths.filter(path=>path.startsWith('/api/')&&path!=='/api/session.requestSnapshot').length,0)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,fullGraph:true,fixtureTransport:true,independentHarnessCapture:true,onDemandScope:'harness',selectedRequestOnly:true,identityFence:true,retry:true,capturedEmpty:true,saveFailureNotEmpty:true,keyboardDisclosure:true,themes:2,narrow:true,chatUsable:true,errors}))
}finally{await browser.close()}
