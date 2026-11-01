// Exercise the real memoized navigation leaf, including key and focus identity.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const id='acceptance:message-rail'
// Retain the feature entry's real locale/slot module augmentations.
const source=compileSourceModules('ui',[
 {id:'acceptance:conversation',source:'src/modules/conversation/index.ts'},
 {id,source:'src/modules/conversation/chat/MessageRail.tsx'},
]).get(id).bytes.toString()
const browser=await require('playwright')[engine].launch({headless:true})
try {
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
 await installOwnedViewPlatform(page,'source')
 await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>window.registration=row}'})
 await page.addScriptTag({content:source})
 await page.evaluate(()=>{
  const React=staticModules.react,DOM=staticModules['react-dom']
  window.tooltipRenders=0;window.selected=[]
  const primitives={Tooltip:({children})=>{tooltipRenders++;return children}}
  const {MessageRail}=registration.factory(name=>name==='@xharness/dsh-client-ui-primitives'?primitives:staticModules[name])
  window.markers=[{key:'a',preview:'first'},{key:'b',preview:'second'}]
  const t=(key,args)=>args?`${key} ${args.n}`:key,select=key=>selected.push(key)
  window.root=DOM.createRoot(document.getElementById('root'))
  window.render=(active='a',translate=t)=>DOM.flushSync(()=>root.render(React.createElement(MessageRail,{markers,active,select,t:translate})))
  render();window.first=document.querySelector('[data-message-key="a"]');first.focus()
  for(let n=0;n<100;n++)render()
 })
 assert.equal(await page.evaluate(()=>tooltipRenders),2,'unrelated parent renders do not recreate every tooltip')
 assert.ok(await page.evaluate(()=>first===document.activeElement),'memoization preserves keyboard focus')
 await page.evaluate(()=>render('b'))
 assert.equal(await page.locator('[data-message-key="b"]').getAttribute('aria-current'),'location')
 assert.equal(await page.locator('[data-message-key="a"]').getAttribute('aria-current'),null)
 await page.locator('[data-message-key="b"]').click()
 assert.deepEqual(await page.evaluate(()=>selected),['b'])
 await page.evaluate(()=>{markers=[{key:'earlier',preview:''},...markers];render('b')})
 assert.ok(await page.evaluate(()=>first===document.querySelector('[data-message-key="a"]')),'prepends preserve keyed button identity')
 assert.match(await page.locator('[data-message-key="a"]').getAttribute('aria-label'),/2: first/)
 await page.evaluate(()=>render('b',(key,args)=>args?`localized ${args.n}`:'localized rail'))
 assert.equal(await page.locator('nav').getAttribute('aria-label'),'localized rail')
 assert.equal(await page.locator('[data-message-key="b"]').getAttribute('aria-label'),'localized 3: second')
 assert.deepEqual(errors,[])
 console.log(`${engine}: marker memoization, active position, selection, keyed prepend, focus and locale passed`)
}finally{await browser.close()}
