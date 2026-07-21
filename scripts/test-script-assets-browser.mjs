// Actual DOM/IPC-shaped bridge A/B against the independent merged-master scripts.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {scriptAsset} from './fixtures/script-asset-test.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS ?? '.', 'package.json'))
const {chromium,webkit}=require('playwright')
const engine=process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const browser=await ({chromium,webkit}[engine]).launch({headless:true})
const observed=[]
try {
  for(const impl of ['legacy','source']) {
    const page=await browser.newPage({viewport:{width:1254,height:768}}),errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.setContent('<div id="root"><p>hydrated app fixture</p></div>')
    await page.evaluate(()=>{
      window.__calls=[]; window.__phases=[]; window.__state={seq:1,phase:'available',version:'9.9.9',downloaded:0,total:null};
      window.__TAURI__={core:{invoke:async(command,args)=>{
        window.__calls.push([command,args]);
        if(command==='desktop_status')return {updaterConfigured:true};
        if(command==='desktop_report_startup_phase'){window.__phases.push(args.phase);return null;}
        if(command==='desktop_download_update')window.__state={seq:2,phase:'downloaded',version:'9.9.9',notes:'<img onerror=alert(1)>'};
        if(command==='desktop_install_update')window.__state={seq:3,phase:'installed'};
        return window.__state;
      }},event:{listen:async(_name,listener)=>{window.__emit=listener;return ()=>{window.__unlistened=true}}}};
    })
    for(const path of ['desktop-startup.js','desktop-titlebar.js','desktop-updater.js','logo-motion.js'])
      await page.addScriptTag({content:scriptAsset(path,impl)})
    const host=page.locator('#xharness-desktop-updater'),toggle=host.locator('.toggle'),panel=host.locator('.panel')
    await host.waitFor({state:'visible'});await page.waitForFunction(()=>window.__phases.includes('first_frame'))
    assert.equal(await panel.isVisible(),false)
    await toggle.click(); assert.equal(await panel.isVisible(),true)
    assert.equal(await host.locator('.action').textContent(),'下载更新')
    await host.locator('.action').click(); await page.waitForFunction(()=>window.__state.phase==='downloaded')
    assert.equal(await host.locator('.notes').textContent(),'<img onerror=alert(1)>')
    assert.equal(await host.locator('.notes img').count(),0)
    await host.locator('.action').click();assert.equal(await host.locator('.confirm').isVisible(),true)
    await toggle.press('Escape');assert.equal(await panel.isVisible(),false)
    assert.equal(await page.evaluate(()=>window.__calls.some(row=>row[0]==='desktop_install_update')),false)
    await toggle.click();await host.locator('.action').click();await host.locator('.action').click()
    await page.waitForFunction(()=>window.__state.phase==='installed')
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')))
    assert.equal(await page.evaluate(()=>window.__unlistened),true)
    assert.deepEqual(errors,[])
    observed.push(await page.evaluate(()=>({
      commands:window.__calls.filter(row=>row[0]!=='desktop_check_update').map(row=>[row[0],row[1]??null]),
      phases:window.__phases,hidden:document.documentElement.hasAttribute('data-xh-page-hidden'),
      update:document.querySelector('#xharness-desktop-updater').shadowRoot.querySelector('.text').textContent,
    })))
    await page.close()
  }
  assert.deepEqual(observed[1],observed[0])
  console.log(`PASS ${engine}: latest-master/source desktop scripts strict build and actual DOM/commands/confirmation/startup/lifecycle A/B`)
}finally{await browser.close()}
