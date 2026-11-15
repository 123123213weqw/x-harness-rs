// Real shipped module, real pinned xterm and platform React. Only HTTP PTY replies
// are fixtures; no Host, model, native desktop input or user conversations.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {verifyArtifact} from './fixtures/shipped-source-values.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'scripts/ui-test-deps','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const shipped=verifyArtifact('@xlang/xharness-client-ui-terminal')
const browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[],calls=[]
 page.setDefaultTimeout(15000);page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewHtml(page,'source',`<html><body style="margin:0;height:100vh;overflow:hidden"><div data-xh-center-column style="position:absolute;left:200px;top:0;width:700px;height:100vh;display:flex;flex-direction:column;box-sizing:border-box"><div id="chat" style="flex:1;min-height:0">Chat remains usable</div><div id="root" style="height:0;flex:none"></div></div></body></html>`)
 await page.route('**/vendor/xterm.*',route=>{const name=new URL(route.request().url()).pathname.split('/').at(-1);return route.fulfill({body:readFileSync(join('ui/dist/plugins/@xlang/xharness-client-ui-terminal/vendor',name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'})})
 await page.route('**/api/terminal/*',route=>{calls.push({action:new URL(route.request().url()).pathname.split('/').at(-1),args:route.request().postDataJSON()});return route.fulfill({json:{ok:true,terminals:[{name:'proof',running:false}],read:{cursor:0,running:false,content_base64:'',exit_code:0,exit_signal:null}}})})
 await page.evaluate(()=>{
  const Native=ResizeObserver;window.liveObservers=new Set()
  window.ResizeObserver=class extends Native{constructor(fn){super(fn);liveObservers.add(this)}disconnect(){super.disconnect();liveObservers.delete(this)}}
  window.__ModuleLoader__={load:p=>window.registration=p}
 })
 await page.addScriptTag({content:shipped})
 await page.evaluate(()=>{
  window.P=registration.factory(id=>staticModules[id]);window.comps={}
  P.apply({effect:fn=>fn(),locale:{register:()=>{}},slots:{inject:(_name,fn)=>fn(),register:(info,component)=>comps[info.id]=component}})
  window.store=P.getDockStore('isolated-fit');store.open=true;store.height=500
  window.tab=new P.TerminalTab('proof',{name:'proof',running:false},store);store.tabs=[tab];store.active='proof'
  window.root=ReactDOM.createRoot(document.getElementById('root'));ReactDOM.flushSync(()=>root.render(React.createElement(comps['xharness-terminal-dock'],{sessionId:'isolated-fit'})))
 })
 const settled=()=>page.waitForFunction(()=>{
  const host=document.querySelector('.xhterm-viewport'),screen=document.querySelector('.xterm-screen'),column=document.querySelector('[data-xh-center-column]'),dock=document.querySelector('.xhterm-dock')
  if(!host||!screen||!dock||!tab.term||!column)return false
  const style=getComputedStyle(host),width=host.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-tab.term._core.viewport.scrollBarWidth,height=host.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),cell=tab.term._core._renderService.dimensions.css.cell
  return cell.height>0&&tab.term.rows===Math.floor(height/cell.height)&&tab.term.cols===Math.floor(width/cell.width)&&screen.getBoundingClientRect().height<=height+1&&screen.getBoundingClientRect().width<=width+1&&Math.abs(parseFloat(getComputedStyle(column).paddingBottom)-dock.getBoundingClientRect().height)<1
 })
 for(const [height,saved] of [[800,500],[460,500],[340,640],[900,640],[800,160]]){
  await page.setViewportSize({width:1100,height});await page.evaluate(h=>store.setHeight(h),saved);await settled()
  const r=await page.evaluate(()=>({rows:tab.term.rows,cols:tab.term.cols,chat:document.querySelector('#chat').getBoundingClientRect().height,dock:document.querySelector('.xhterm-dock').getBoundingClientRect().height,padding:parseFloat(getComputedStyle(document.querySelector('[data-xh-center-column]')).paddingBottom)}))
  assert.ok(r.rows>0&&r.cols>0);assert.ok(r.chat>=219,'actual clamped reservation leaves the chat band usable: '+JSON.stringify(r));console.log(engine+' fitted',JSON.stringify({height,saved,...r}))
 }
 await page.waitForTimeout(250)
 const count=calls.filter(c=>c.action==='resize').length
 await page.evaluate(()=>new Promise(resolve=>tab.term.write('\x1b[2J\x1b[H'+Array.from({length:tab.term.rows},(_,i)=>'visible row '+(i+1)).join('\r\n'),resolve)))
 await page.waitForTimeout(250);assert.equal(calls.filter(c=>c.action==='resize').length,count,'output with unchanged metrics cannot churn PTY resizes')
 await page.evaluate(()=>document.getElementById('root').style.display='none');await settled()
 assert.equal(await page.locator('.xhterm-dock').isVisible(),true,'portal survives composer visibility changes')
 await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Control+`');await page.locator('.xhterm-dock').waitFor({state:'detached'})
 assert.equal(await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('[data-xh-center-column]')).paddingBottom)),0)
 await page.keyboard.press('Control+`');await settled()
 await page.evaluate(()=>ReactDOM.flushSync(()=>root.unmount()))
 assert.equal(await page.locator('.xhterm-dock').count(),0)
 assert.equal(await page.evaluate(()=>document.body.classList.contains('xhterm-dock-open')),false)
 assert.equal(await page.evaluate(()=>document.body.style.getPropertyValue('--xhterm-dock-h')),'')
 assert.equal(await page.evaluate(()=>liveObservers.size),0,'all fitting, geometry and vendored terminal observers disposed')
 assert.deepEqual(errors,[])
 console.log(engine+': actual xterm metrics, no clipping, PTY resize, short-window clamp, persisted height, portal/keyboard/reduced-motion and observer cleanup passed')
}finally{await browser.close()}
