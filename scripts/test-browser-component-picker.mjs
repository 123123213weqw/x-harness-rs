// Real browser DOM interaction; native IPC/screenshot capture are not simulated
// as native acceptance by this test. The shipped fixed picker script is used.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await require('playwright')[engine].launch({headless:true})
const script=readFileSync(new URL('../apps/desktop/src-tauri/src/browser_picker.js',import.meta.url),'utf8')
const page=await browser.newPage({viewport:{width:900,height:700}})
let cases=0
try{
  const fixture=async()=>{
    await page.setContent(`<style>body{margin:0;height:2000px}#group{position:absolute;left:100px;top:120px;width:300px;height:180px;display:flex;gap:10px}button{width:120px;height:60px;background:rgb(12,34,56)}#shadow{position:absolute;left:500px;top:120px}</style><section id="group"><button id="primary">Save</button><button id="secondary">Cancel</button><input type="password" value="secret-never-export"></section><div id="shadow"></div><iframe style="position:absolute;left:500px;top:300px;width:120px;height:80px"></iframe>`)
    await page.evaluate(()=>{window.scrollTo(0,0);window.effects=0;window.globalEffects=0;document.onclick=()=>window.globalEffects++;document.getElementById('primary').onclick=()=>window.effects++;document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow action</button>'});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  }
  const run=args=>page.evaluate(({script,args})=>(0,eval)(`(${script})`)(args),{script,args}).then(JSON.parse)
  // Form-control defaults differ across Linux/macOS browser builds. Resolve
  // fixture targets from real DOM geometry; do not assume an unshrunk flex item.
  const bounds=async selector=>{const r=await page.locator(selector).boundingBox();assert.ok(r&&r.width>0&&r.height>0,selector+' must be laid out');return r}
  const center=r=>({x:r.x+r.width/2,y:r.y+r.height/2})
  const click=async point=>page.mouse.click(point.x,point.y)
  const start=()=>run({action:'start',token:'test-token'})
  const poll=()=>run({action:'poll',token:'test-token'})
  await fixture();let primary=center(await bounds('#primary'));await start();await page.mouse.move(primary.x,primary.y);await click(primary)
  let reply=await poll();assert.equal(reply.status,'selected');assert.equal(reply.selection.elements[0].id,'primary');assert.equal(reply.selection.mode,'element');assert.equal(reply.selection.elements[0].styles['background-color'],'rgb(12, 34, 56)');assert.equal(await page.evaluate(()=>window.effects),0,'picking must not invoke page actions');assert.equal(await page.evaluate(()=>window.globalEffects),0,'selection click cannot reach document handlers');assert.equal((await poll()).status,'cancelled','evidence consumed once');cases++
  await fixture();const group=await bounds('#group');await start();await page.mouse.move(group.x-10,group.y-10);await page.mouse.down();await page.mouse.move(group.x+group.width+10,group.y+group.height+10,{steps:5});await page.mouse.up();reply=await poll();assert.equal(reply.selection.mode,'region');assert.equal(reply.selection.elements[0].id,'group');assert.ok(!JSON.stringify(reply).includes('secret-never-export'));cases++
  await fixture();primary=center(await bounds('#primary'));await start();await page.keyboard.press('Escape');assert.equal((await poll()).status,'cancelled');await click(primary);assert.equal(await page.evaluate(()=>window.effects),1,'cancelling restores ordinary page input');cases++
  await fixture();await start();await page.evaluate(()=>window.scrollTo(0,100));await page.waitForTimeout(100);assert.equal((await poll()).status,'cancelled','scroll invalidates viewport');cases++
  await fixture();await start();await page.setViewportSize({width:850,height:700});await page.waitForTimeout(100);assert.equal((await poll()).status,'cancelled','resize invalidates viewport');cases++
  await fixture();const shadow=center(await bounds('#shadow-button'));await start();await click(shadow);reply=await poll();assert.equal(reply.selection.elements[0].root,'shadow-root');assert.equal(reply.selection.elements[0].id,'shadow-button');cases++
  await fixture();const frame=center(await bounds('iframe'));await start();await click(frame);reply=await poll();assert.equal(reply.selection.elements[0].opaqueFrame,true);cases++
  await fixture();primary=center(await bounds('#primary'));await start();assert.equal((await run({action:'poll',token:'wrong'})).status,'cancelled');await run({action:'cancel',token:'test-token'});await click(primary);assert.equal(await page.evaluate(()=>window.effects),1);cases++
  await fixture();const partial=await bounds('#primary');assert.ok(partial.width>20&&partial.height>20,'partial region fixture must have an interior');await start();await page.mouse.move(partial.x+5,partial.y+5);await page.mouse.down();await page.mouse.move(partial.x+partial.width-5,partial.y+partial.height-5,{steps:3});await page.mouse.up();reply=await poll();assert.equal(reply.selection.mode,'region');assert.equal(reply.selection.elements[0].id,'primary','partial component region falls back to the center DOM target');cases++
  await fixture();await page.evaluate(()=>{const group=document.getElementById('group');group.style.cssText='position:absolute;left:100px;top:100px;width:400px;height:550px;display:grid;grid-template-columns:repeat(4,60px);align-content:start;gap:10px';group.innerHTML=Array.from({length:12},(_,i)=>'<div style="height:30px">item '+i+'</div>').join('')});await start();await page.mouse.move(90,90);await page.mouse.down();await page.mouse.move(430,250,{steps:3});await page.mouse.up();reply=await poll();assert.equal(reply.selection.elements.length,8);assert.equal(reply.selection.truncated,true,'bounded region evidence must declare truncation');cases++
  console.log(`${engine}: component picker ${cases} real DOM cases passed`)
}finally{await browser.close()}
