import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {mkdirSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {toolArgumentPreviewFiles,serveToolArgumentPreview} from './fixtures/tool-argument-progress-page.mjs'

const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const files=toolArgumentPreviewFiles()
assert.equal(files.get('preview/theme/monochrome.css').toString(),readFileSync(new URL('../ui/overrides/monochrome.css',import.meta.url),'utf8'),'preview uses the exact product palette')
assert.ok(!/#[\da-f]{3,8}\b/i.test(files.get('index.html').toString()),'preview layout must not define a second palette')
const server=createServer((request,response)=>serveToolArgumentPreview(files,request,response))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await require('playwright')[engine].launch({headless:true})
try {
  const page=await browser.newPage({viewport:{width:960,height:800},colorScheme:'light'}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{
    const start=window.setInterval,clear=window.clearInterval,active=new Set()
    window.testToolTimers=active
    window.setInterval=(callback,delay,...args)=>{const id=start(callback,delay,...args);if(delay===1000)active.add(id);return id}
    window.clearInterval=id=>{active.delete(id);clear(id)}
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(()=>window.previewApi)
  const card=page.locator('[data-tool-phase="generating"]'),toggle=card.locator('button').first()
  await card.waitFor()
  assert.match(await toggle.textContent(),/正在生成工具参数.*bash/)
  assert.equal(await toggle.getAttribute('aria-expanded'),'false')
  await toggle.focus();await toggle.press('Enter')
  assert.equal(await toggle.getAttribute('aria-expanded'),'true')
  assert.match(await card.locator('pre').textContent(),/## 项目结构\n/)
  assert.match(await card.textContent(),/工具尚未执行/)
  async function assertProductPalette(scheme) {
    const values=await page.evaluate(()=>{
      const root=document.querySelector('[data-tool-phase="generating"]'),probe=document.createElement('span')
      document.body.appendChild(probe)
      const rows=[
        ['.xh-tool-preparing','backgroundColor','--dsw-alias-bg-layer-1'],
        ['.xh-tool-preparing','color','--dsw-alias-label-primary'],
        ['.xh-tool-preparing-dot','backgroundColor','--dsw-alias-label-tertiary'],
        ['.xh-tool-preparing-input','backgroundColor','--dsw-alias-markdown-code-block'],
        ['.preview-user','backgroundColor','--dsw-specific-bubble'],
      ].map(([selector,property,token])=>{
        probe.style.color=`var(${token})`
        return {selector,actual:getComputedStyle(document.querySelector(selector))[property],expected:getComputedStyle(probe).color}
      })
      probe.remove()
      const head=root.querySelector('.xh-tool-preparing-toggle').getBoundingClientRect(),body=root.querySelector('.xh-tool-preparing-body').getBoundingClientRect()
      return {rows,display:getComputedStyle(root).display,animation:getComputedStyle(root).animationName,stacked:body.top>=head.bottom}
    })
    for(const row of values.rows){
      assert.equal(row.actual,row.expected,`${scheme} ${row.selector}: exact product token`)
      const channels=row.actual.match(/[\d.]+/g).slice(0,3)
      assert.equal(channels[0],channels[1],`${scheme}: neutral, not bluish`)
      assert.equal(channels[1],channels[2],`${scheme}: neutral, not bluish`)
    }
    assert.equal(values.display,'block','legacy preparing badge must not override card layout')
    assert.equal(values.animation,'none','whole card must not pulse while user reads')
    assert.equal(values.stacked,true,'body stays below header with product overrides enabled')
  }
  await assertProductPalette('light')
  await page.getByRole('button',{name:'切换预览配色',exact:true}).click()
  assert.equal(await page.locator('body').getAttribute('data-ds-dark-theme'),'')
  await assertProductPalette('dark')
  if(process.env.UI_TOOL_ARGUMENT_RECEIPT_DIR){
    mkdirSync(process.env.UI_TOOL_ARGUMENT_RECEIPT_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.UI_TOOL_ARGUMENT_RECEIPT_DIR,`tool-argument-progress-${engine}-dark.png`),fullPage:true})
  }
  await page.getByRole('button',{name:'切换预览配色',exact:true}).click()

  const startedAt=Date.now()-7000
  const raw='{"command":"echo 中文😀\\n<img src=x onerror=alert(1)> '
  const block={kind:'tool-call',callId:'a',name:'bash',argsRaw:raw,startedAt}
  await page.evaluate(block=>previewApi.render([block]),block)
  await toggle.click()
  assert.match(await toggle.textContent(),new RegExp(`${Buffer.byteLength(raw)} B`))
  assert.equal(await card.locator('pre').textContent(),'echo 中文😀\n<img src=x onerror=alert(1)> ')
  assert.equal(await card.locator('img').count(),0,'preview text cannot execute HTML')
  await card.getByRole('button',{name:'查看原始 JSON',exact:true}).click()
  assert.equal(await card.locator('pre').textContent(),raw)
  await page.evaluate(block=>previewApi.render([{...block,argsRaw:block.argsRaw+'next'}]),block)
  assert.equal(await toggle.getAttribute('aria-expanded'),'true','append preserves disclosure')
  assert.equal(await card.locator('pre').textContent(),raw+'next','raw mode remains authoritative')
  assert.match(await toggle.textContent(),/· [7-9] 秒/,'first delta time is not reset by append')

  await page.evaluate(block=>{previewApi.render([],false);previewApi.render([block])},block)
  assert.equal(await toggle.getAttribute('aria-expanded'),'true','virtualization retains disclosure')
  assert.equal(await card.locator('pre').textContent(),raw,'virtualization retains raw-mode choice')
  await page.evaluate(block=>previewApi.render([{...block,startedAt:Date.now()}]),block)
  assert.equal(await toggle.getAttribute('aria-expanded'),'false','retry starts a distinct UI seat')

  const large={...block,callId:'large',name:'write',argsRaw:JSON.stringify({content:'文😀\n'.repeat(10000)}).slice(0,-2)}
  await page.evaluate(block=>previewApi.render([block]),large);await toggle.click()
  assert.ok((await card.locator('pre').textContent()).length<=16384)
  assert.match(await card.textContent(),/实际工具参数未被截断/)
  assert.ok(large.argsRaw.length>16384,'large authoritative input is intact')
  await page.setViewportSize({width:390,height:844})
  await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''))
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'narrow view has no horizontal overflow')
  await page.emulateMedia({reducedMotion:'reduce'})
  assert.equal(await card.locator('.xh-tool-preparing-dot').evaluate(el=>getComputedStyle(el).animationName),'none')

  await page.evaluate(block=>previewApi.render([block,{...block,callId:'parallel',name:'apply_patch',startedAt:Date.now()}]),block)
  assert.equal(await card.count(),2,'normalized deltas support distinct concurrent tools')
  await page.evaluate(block=>previewApi.render([{...block,name:''}]),block)
  assert.equal(await card.count(),0,'empty tool identity does not produce a misleading card')
  await page.evaluate(block=>previewApi.render([{...block,argsRaw:'{"command":"echo hello"}'}]),block)
  assert.equal(await card.count(),0,'complete small JSON hands off through existing lifecycle')
  await page.evaluate(block=>previewApi.render([block],false,true),block)
  assert.equal(await card.count(),0,'cancellation removes generation phase')
  assert.equal(await page.evaluate(()=>testToolTimers.size),0,'cancel clears elapsed timer')
  await page.evaluate(()=>previewApi.show('running'))
  await page.locator('[data-tool="bash"]').waitFor()
  assert.equal(await card.count(),0,'actual ToolRow owns execution phase')
  await page.evaluate(()=>previewApi.show('done'))
  const executionToggle=page.locator('[data-tool="bash"] [aria-expanded]').first()
  if(await executionToggle.getAttribute('aria-expanded')==='false')await executionToggle.click()
  await page.getByText('模拟结果：文档写入成功，实际未执行任何命令。',{exact:true}).waitFor()

  await page.evaluate(block=>{previewApi.setLocale('en');previewApi.render([block])},block)
  assert.match(await toggle.textContent(),/Generating tool input/)
  await page.evaluate(()=>{previewApi.setLocale('zh');document.body.removeAttribute('data-ds-dark-theme');previewApi.show('generating')})
  await page.setViewportSize({width:960,height:800})
  if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click()
  if(process.env.UI_TOOL_ARGUMENT_RECEIPT_DIR){
    mkdirSync(process.env.UI_TOOL_ARGUMENT_RECEIPT_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.UI_TOOL_ARGUMENT_RECEIPT_DIR,`tool-argument-progress-${engine}.png`),fullPage:true})
  }
  await page.evaluate(()=>previewApi.render([],false))
  assert.equal(await page.evaluate(()=>testToolTimers.size),0)
  assert.deepEqual(errors,[])
  console.log(`${engine}: real tool argument UI passed (exact product light/dark palette, no legacy badge override, keyboard, decoded/raw, UTF-8, escaping, append, retained state, retry, cap, narrow/dark, reduced motion, multiple tools, handoff, cancellation, locale, timer cleanup)`)
} finally {
  await browser.close()
  await new Promise(resolve=>server.close(resolve))
}
