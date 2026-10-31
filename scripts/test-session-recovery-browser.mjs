import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {createServer} from 'node:http'
import {compile} from './conversation-test-harness.mjs'
import {exposeModuleUnit} from './fixtures/module-unit-scope.mjs'
import {installSharedSourceVendors} from './fixtures/shared-source-vendors.mjs'
const deps=process.env.UI_TEST_DEPS??'/tmp/ui-tests',require=createRequire(resolve(deps,'package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const source=exposeModuleUnit(compile().test,'conversation','skeleton/SessionRecoveryButton','SessionRecoveryButton','test-exports')
const server=createServer((_,res)=>{res.setHeader('content-type','text/html');res.end('<div id="root"></div>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 for(const f of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(deps,'node_modules',f)})
 await installSharedSourceVendors(page)
 await page.addScriptTag({content:'window.__ModuleLoader__={load:r=>window.registration=r}'})
 await page.addScriptTag({content:source})
 await page.evaluate(()=>{
  const jsx=(type,props,key)=>React.createElement(type,key===undefined?props:{...props,key})
  const plugin=registration.factory(name=>name==='zod'?__sourceVendors.zod:name==='react'?React:name==='react-dom'?ReactDOM:name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:React.Fragment}:name==='@xharness/cordis'?{Service:class{}}:new Proxy({},{get:()=>()=>null}))
  window.recoveries=[];window.owner='A';const root=ReactDOM.createRoot(document.getElementById('root'))
  window.recover=()=>new Promise((resolve,reject)=>recoveries.push({owner,resolve,reject}))
  window.draw=()=>ReactDOM.flushSync(()=>root.render(React.createElement(React.Fragment,null,
   React.createElement('textarea',{'aria-label':'draft',defaultValue:'keep my draft'}),
   React.createElement(plugin.SessionRecoveryButton,{sessionId:owner,recover,t:key=>plugin.en[key]}))))
  window.dispose=()=>root.unmount();draw()
 })
 const button=page.getByRole('button',{name:'Recover task',exact:true})
 await button.click();await page.getByRole('button',{name:'Recovering…',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>recoveries.length),1)
 await page.evaluate(()=>document.querySelector('[data-session-recovery] button').click())
 assert.equal(await page.evaluate(()=>recoveries.length),1,'pending recovery cannot be double-submitted')
 await page.evaluate(()=>recoveries[0].reject(Error('Stop active work first')))
 await page.getByRole('alert').getByText('Stop active work first',{exact:true}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'draft'}).inputValue(),'keep my draft')
 await button.click();await page.evaluate(()=>{owner='B';draw()})
 await button.waitFor();await page.evaluate(()=>recoveries[1].resolve())
 assert.equal(await page.getByRole('status').count(),0,'late A success cannot acknowledge B')
 await button.click();await page.evaluate(()=>recoveries[2].resolve())
 await page.getByRole('status').getByText('Recovered',{exact:true}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'draft'}).inputValue(),'keep my draft')
 await button.click();await page.evaluate(()=>{dispose();recoveries[3].reject(Error('late failure'))})
 assert.deepEqual(errors,[])
 console.log(`${engine}: recovery latch, explicit failure, session/unmount epoch and unchanged draft passed`)
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
