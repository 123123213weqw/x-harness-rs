import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {layoutUnitModuleTestInput} from './fixtures/layout-module-test-input.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium',browser=await require('playwright')[engine].launch({headless:true})
try{
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
 await page.clock.install({time:new Date('2026-10-31T00:00:00Z')})
 await installOwnedViewHtml(page,'source','<div id="root"></div>')
 await page.addScriptTag({content:'window.__ModuleLoader__={load:r=>window.registration=r}'})
 await page.addScriptTag({content:layoutUnitModuleTestInput('workspace-pane.js',['XhWorkspacePane'])})
 await page.evaluate(()=>{
  const api=registration.factory(name=>staticModules[name]??{})
  const file=id=>({id,kind:'file',source:id,title:id,entries:[],position:-1})
  window.spaces={A:{items:Array.from({length:7},(_,i)=>file('f'+i)),activeId:'f0'},B:{items:[file('f0')],activeId:'f0'}}
  window.owner='A';window.open=true;window.mounts={};window.unmounts={};window.jobs={}
  function Page({item,sessionId,onUpdate}){
   const key=sessionId+':'+item.id,[text,setText]=React.useState('initial '+key),[done,setDone]=React.useState(false)
   React.useEffect(()=>{mounts[key]=(mounts[key]??0)+1;jobs[key]=()=>{setDone(true);onUpdate({title:'done '+key})};return()=>{unmounts[key]=(unmounts[key]??0)+1}},[])
   return React.createElement('div',null,React.createElement('input',{'aria-label':key,value:text,onChange:e=>setText(e.target.value)}),done&&React.createElement('span',{'data-done':key},'done'))
  }
  const root=ReactDOM.createRoot(document.getElementById('root'))
  window.draw=()=>ReactDOM.flushSync(()=>root.render(React.createElement(api.XhWorkspacePane,{space:spaces[owner],spaces,open,sessionId:owner,
   renderSlot:(_,props)=>React.createElement(Page,props),onSelect:id=>{spaces={...spaces,[owner]:{...spaces[owner],activeId:id}};draw()},
   onClose:id=>{spaces={...spaces,[owner]:{...spaces[owner],items:spaces[owner].items.filter(item=>item.id!==id),activeId:null}};draw()},
   onUpdate:()=>{throw Error('cross-session update must use captured owner')},
   onUpdateOwner:(key,id,patch)=>{spaces={...spaces,[key]:{...spaces[key],items:spaces[key].items.map(item=>item.id===id?{...item,...patch}:item)}};draw()},onNewBrowser:()=>{}})))
  draw()
 })
 await page.getByRole('textbox',{name:'A:f0',exact:true}).fill('retained draft')
 await page.evaluate(()=>{owner='B';draw()})
 await page.getByRole('textbox',{name:'B:f0',exact:true}).waitFor()
 await page.evaluate(()=>jobs['A:f0']())
 assert.equal(await page.evaluate(()=>spaces.A.items[0].title),'done A:f0')
 assert.equal(await page.evaluate(()=>spaces.B.items[0].title),'f0')
 assert.equal(await page.locator('[data-workspace-page-owner="A"]').getAttribute('inert'),'')
 await page.evaluate(()=>{owner='A';draw()})
 assert.equal(await page.getByRole('textbox',{name:'A:f0',exact:true}).inputValue(),'retained draft')
 assert.equal(await page.evaluate(()=>mounts['A:f0']),1)
 await page.evaluate(()=>{open=false;draw()})
 assert.equal(await page.getByRole('textbox').count(),0,'hidden pages are not interactive')
 await page.clock.fastForward(300_000)
 await page.waitForFunction(()=>document.querySelectorAll('[data-workspace-page-state]').length===0)
 assert.equal(await page.evaluate(()=>unmounts['A:f0']),1)
 await page.evaluate(()=>{open=true;draw()})
 for(let i=1;i<7;i++)await page.getByRole('tab',{name:'f'+i,exact:true}).click()
 assert.ok(await page.locator('[data-workspace-page-state]').count()<=4)
 await page.getByRole('button',{name:'关闭 f6',exact:true}).click()
 assert.equal(await page.evaluate(()=>unmounts['A:f6']),1)
 assert.deepEqual(errors,[])
 console.log(`${engine}: page identity, background completion, owner isolation, inert hiding, 5-minute expiry, LRU budget and explicit close passed`)
}finally{await browser.close()}
