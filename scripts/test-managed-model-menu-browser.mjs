// Real platform React/primitives and source components, fixture RPC, no paid API.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {mkdirSync} from 'node:fs'
import {createManagedModelPreview} from './preview-managed-model-menu.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium', browser=await require('playwright')[engine].launch({headless:true})
const server=createManagedModelPreview();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`
const errors=[];let scenarios=0
try{
 for(const lang of ['zh','en'])for(const theme of ['dark','light']){
  const page=await browser.newPage({viewport:{width:900,height:620}})
  page.on('pageerror',e=>{if(!e.message.includes('Host boot intentionally disabled'))errors.push(e.message)})
  page.setDefaultTimeout(10000);await page.goto(`${origin}/?lang=${lang}&theme=${theme}`)
  const copy=lang==='zh'?{custom:'自定义',model:/^模型 /,account:'账号服务',manage:'管理模型',back:'返回模型',close:'关闭'}:{custom:'Custom',model:/^Model /,account:'Account service',manage:'Manage models',back:'Back to models',close:'Close'}
  const trigger=()=>page.locator('#fixture-picker button[aria-haspopup=menu]')
  const open=async()=>{await trigger().click();await page.keyboard.press('ArrowDown');assert.equal(await page.getByRole('menuitem',{name:copy.model}).evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Enter')}
  await open()
  assert.equal(await page.getByText(copy.account,{exact:true}).count(),1)
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(),['DeepSeek Flash','GLM Flash'])
  assert.equal(await page.getByRole('menuitemradio',{name:'DeepSeek Flash',exact:true}).getAttribute('aria-checked'),'true')
  assert.equal(await page.getByText('BigModel',{exact:true}).count(),0,'provider names must not leak into primary menu')
  await page.getByRole('menuitem',{name:copy.custom,exact:true}).click()
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(),['My GLM','Local model'])
  assert.equal(await page.getByText(copy.account,{exact:true}).count(),0,'name collision XHarness must remain custom')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('menuitemradio',{name:'GLM Flash',exact:true}).count(),1)
  await page.getByRole('menuitem',{name:copy.custom,exact:true}).click();await page.getByRole('menuitem',{name:copy.back,exact:true}).click()
  await page.getByRole('menuitemradio',{name:'GLM Flash',exact:true}).click()
  await page.waitForFunction(()=>fixture.saved.model==='glm-5.3-flash')
  assert.equal(await page.evaluate(()=>fixture.saved.provider),'xharness-managed')
  assert.equal(await trigger().getAttribute('aria-expanded'),'false')
  assert.equal(await trigger().evaluate(el=>el===document.activeElement),true)
  await open();await page.getByRole('menuitem',{name:copy.custom,exact:true}).click();await page.getByRole('menuitemradio',{name:'My GLM',exact:true}).click()
  await page.waitForFunction(()=>fixture.saved.provider==='bigmodel')
  assert.equal(await page.evaluate(()=>fixture.saved.model),'glm-5.3-flash','same model ID selects correct provider')
  await open();await page.getByRole('menuitem',{name:copy.manage,exact:true}).click()
  await page.getByTestId('models-settings').waitFor()
  assert.equal(await trigger().getAttribute('aria-expanded'),'false')
  await page.getByRole('button',{name:copy.close,exact:true}).click()
  assert.equal(await trigger().evaluate(el=>el===document.activeElement),true,'closing settings restores composer focus')
  await page.evaluate(async()=>{fixture.account=false;await fixture.directory.load()})
  await open();assert.equal(await page.getByText(copy.account,{exact:true}).count(),0)
  await page.getByRole('menuitem',{name:copy.custom,exact:true}).click();assert.equal(await page.getByRole('menuitemradio').count(),2)
  await page.keyboard.press('ArrowLeft');await page.getByRole('menuitem',{name:copy.custom,exact:true}).waitFor()
  await page.evaluate(()=>{fixture.offline=true})
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');await open()
  await page.getByText(/offline/).waitFor();assert.equal(await page.getByRole('menuitem',{name:copy.custom,exact:true}).count(),1)
  await page.evaluate(async()=>{fixture.offline=false;fixture.custom=false;await fixture.directory.load()});
  await page.getByRole('menuitem',{name:copy.custom,exact:true}).click();
  await page.getByText(lang==='zh'?'没有自定义模型。请在管理模型中添加。':'No custom models. Add one in Manage models.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('menuitem',{name:copy.manage,exact:true}).count(),1);
  await page.getByRole('menuitem',{name:copy.back,exact:true}).click();
  await page.evaluate(async()=>{fixture.custom=true;fixture.account=true;await fixture.directory.load()})
  for(const width of [900,520,320]){
   await page.setViewportSize({width,height:620})
   const box=await page.getByRole('menu').boundingBox()
   assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=620,JSON.stringify(box))
   assert.notEqual(await page.getByRole('menu').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','real theme tokens present')
  }
  if(process.env.UI_TEST_SCREENSHOTS){await page.getByRole('menuitemradio',{name:'DeepSeek Flash',exact:true}).click();await trigger().click();await page.getByRole('menuitem',{name:copy.model}).click();await page.mouse.move(20,100);mkdirSync(process.env.UI_TEST_SCREENSHOTS,{recursive:true});await page.setViewportSize({width:900,height:620});await page.screenshot({path:resolve(process.env.UI_TEST_SCREENSHOTS,`${engine}-${lang}-${theme}.png`)})}
  await page.close();scenarios++
 }
 assert.deepEqual(errors,[])
 console.log(`${engine}: ${scenarios} bilingual/theme scenarios passed; account/custom isolation, provider-ID collision, selection, keyboard/back/focus, settings navigation, no-account/offline and 900/520/320px geometry`)
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
