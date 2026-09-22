/** Genuine generated graph; only the built-in fixture baseline is enriched
 * with the shared Rust wire fixture. No production component is mocked. */
import assert from 'node:assert/strict'
import {readFileSync,existsSync,mkdirSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
import {createRequire} from 'node:module'
const reception=process.argv.includes('--reception')
const engine=process.env.UI_TEST_BROWSER??'chromium',deps=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const require=createRequire(resolve(deps,'package.json')),base=resolve('ui/dist'),fixture=JSON.parse(readFileSync(reception ? 'protocol/fixtures/performance-reception-v1.json' : 'protocol/fixtures/performance-timeline-v1.json','utf8'))
const connectionPath='/plugins/@xharness/dsh-client-connection/client.js'
const marker="values['sessionStats'] = sessionStatsOf(log);"
const browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:1280,height:900},locale:'en-US'}),errors=[],requests=[]
 page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());requests.push(url.pathname)
  if(url.hostname!=='127.0.0.1')return route.abort('blockedbyclient')
  const file=resolve(base,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname))
  if(!file.startsWith(base+sep)||!existsSync(file))return route.fulfill({status:404,body:'fixture asset missing'})
  let body=readFileSync(file)
  if(url.pathname===connectionPath){const text=body.toString();assert.equal(text.split(marker).length,2,'exact isolated transport-fixture seam');body=Buffer.from(text.replace(marker,marker+`\nvalues['performanceTimeline'] = ${JSON.stringify(fixture)};`))}
  const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm'}
  return route.fulfill({body,contentType:types[extname(file)]??'application/octet-stream'})
 })
 await page.goto('http://127.0.0.1:39187/?fixture=1')
 await page.getByText('Fixture 历史会话',{exact:true}).waitFor({timeout:60000})
 await page.locator('[data-xh-startup-exit]').waitFor({state:'detached'})
 await page.getByText('Fixture 历史会话',{exact:true}).click()
 const tab=page.getByRole('tab',{name:'Performance',exact:true})
 await tab.waitFor();const labels=await page.getByRole('tab').allTextContents();assert.equal(labels.indexOf('Performance'),labels.indexOf('Harness')+1)
 await tab.click();await page.locator('[data-performance-view]').waitFor()
 const collapse=page.getByRole('button',{name:'Collapse the question card',exact:true});if(await collapse.count()>0)await collapse.click()
 await page.getByText(reception ? 'Reception estimate · before buffering · usage-calibrated after completion' : 'Reception estimate · journal checkpoint timing · not server decode TPS',{exact:true}).first().waitFor()
 if(reception){await page.getByText('100.0 tok/s',{exact:true}).waitFor();assert.equal(await page.getByText('Unknown',{exact:true}).count(),0)}
 const graph=page.locator('.xhperf svg');await graph.waitFor()
 await graph.focus();await graph.press('ArrowRight');await page.getByText('test-model',{exact:true}).waitFor()
 await page.getByRole('button',{name:'3s smoothing',exact:true}).click();assert.equal(await page.getByRole('button',{name:'3s smoothing',exact:true}).getAttribute('aria-pressed'),'true')
 assert.ok((await page.locator('polyline[data-tps-track]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('points')))).every(points=>!points.includes('NaN')&&!points.includes('Infinity')))
 const evidence=resolve('dist/regression/performance-20261012');mkdirSync(evidence,{recursive:true})
 for(const dark of [false,true]){
  await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
  await page.screenshot({path:resolve(evidence,`${engine}-${reception?'reception':'legacy'}-${dark?'dark':'light'}.png`),animations:'disabled'})
 }
 assert.equal(await page.locator('.xhperf tbody tr').count(),0,'collapsed data table is not mounted')
 await page.getByText('Accessible timeline data',{exact:true}).click();assert.equal(await page.locator('.xhperf tbody tr').count(),fixture.turns[0].samples.length)
 for(const width of [520,390]){await page.setViewportSize({width,height:780});const b=await graph.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width+1,'graph stays in viewport')}
 // Switching back must keep the real composer usable and does not reset data.
 await page.getByRole('tab',{name:'Harness',exact:true}).click();await page.locator('.xhctx-harness-root').waitFor()
 await tab.click();await graph.waitFor();await page.getByRole('tab',{name:'Chat',exact:true}).click();assert.ok(await page.locator('textarea,[contenteditable=true]').count()>0)
 assert.ok(requests.includes('/plugins/@xlang/xharness-client-ui-performance/client.js'));assert.ok(!requests.some(p=>p.startsWith('/api/')))
 assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,fullGraph:true,sharedRustFixture:true,tabNextToHarness:true,keyboard:true,themes:2,widths:2,chatUsable:true,errors}))
}finally{await browser.close()}
