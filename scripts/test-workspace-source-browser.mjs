/** Isolated real React + frozen/source complete workspace module nav and picking flow. */
import assert from 'node:assert/strict'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createRequire} from 'node:module'
import {compileSourceModules} from './build-source-modules.mjs'
const deps=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps',require=createRequire(resolve(deps,'package.json')),{chromium,webkit}=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium',implementation=process.env.UI_TEST_IMPL??'source',id='@xharness/dsh-client-ui-workspace',runtimeId='@xharness/dsh-client-runtime'
const outputs=implementation==='source'?compileSourceModules('ui',[{id,source:'src/modules/workspace/index.ts'},{id:runtimeId,source:'src/modules/client-runtime/index.ts'},{id:'navigation-test',source:'src/modules/layout/shell-navigation.ts'}]):undefined
const code=outputs?.get(id).bytes.toString()??readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8')
const runtimeCode=outputs?.get(runtimeId).bytes.toString()??readFileSync(`ui/reference/master-a613970/plugins/${runtimeId}/client.js`,'utf8')
const browser=await({chromium,webkit}[engine]).launch({headless:true})

try{const page=await browser.newPage({viewport:{width:900,height:650}});const errors=[];page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)});await installOwnedViewPlatform(page,implementation);await page.evaluate(()=>document.body.innerHTML='<div id="root" style="width:280px;height:620px"></div>');await page.addScriptTag({content:'window.__ModuleLoader__={load:x=>window.runtimeRegistration=x}'});await page.addScriptTag({content:runtimeCode});await page.addScriptTag({content:'window.__ModuleLoader__={load:x=>window.registration=x}'});await page.addScriptTag({content:code});if(outputs)await page.addScriptTag({content:'window.__ModuleLoader__={load:x=>window.navigationRegistration=x}'});if(outputs)await page.addScriptTag({content:outputs.get('navigation-test').bytes.toString()});await page.evaluate(()=>{
 const source=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;listeners.forEach(fn=>fn())}}};const useSource=(source,select)=>select(React.useSyncExternalStore(source.subscribe,source.getSnapshot));
 const runtime=runtimeRegistration.factory(name=>{if(name in staticModules)return staticModules[name];throw Error(name)})
 const api=registration.factory(name=>{if(name==='@xharness/dsh-client-runtime/client')return runtime;if(name in staticModules)return staticModules[name];throw Error(name)})
 window.trace=[];const registrations=[];window.flow=source(true);window.mode=source(true);window.sectionTitle=source('section.workspaces');window.workspaces=source({items:[],archivedSessionIds:[],phase:'ready',baselinesReady:true,recentWorkspaceId:undefined,state:'idle',error:null});const sessions=source({ids:[],byId:{},current:undefined,phase:'ready'});const ctx={get:()=>({hostDescription:source({home:'/home'})}),effect:fn=>fn(),locale:{register:()=>()=>{}},slots:{inject:(_n,fn)=>fn(),register:(spec,component)=>{registrations.push({spec,component});return()=>{}},entries:()=>flow.getSnapshot()?[{}]:[],subscribe:(_key,fn)=>flow.subscribe(fn)},sessions:{searchResultLimit:50,search:async()=>({ok:true,value:{items:[],hasMore:false}}),open:id=>trace.push(['open',id])},workspaces:{startSession:id=>trace.push(['start',id]),create:async input=>{trace.push(['create',input]);return {workspaceId:'picked'}}}};if(window.navigationRegistration){const{ShellNavigation}=navigationRegistration.factory(name=>staticModules[name]);window.fixtureShellNavigation=new ShellNavigation({list:sessions,open:ctx.sessions.open,clear:()=>sessions.set({...sessions.getSnapshot(),current:undefined}),subagentAddress:()=>undefined});window.closeNavigation=fixtureShellNavigation.mount(window)}api.apply(ctx);const {spec,component}=registrations[0];const face=spec.inject();const view=spec.store.create();const actions=view.actions;
 const Directory=owner=>owner.open?React.createElement('div',{role:'dialog','aria-label':'directory'},React.createElement('button',{onClick:()=>owner.onPicked('/chosen'),disabled:owner.busy},'Use folder'),React.createElement('button',{onClick:owner.onCancel},'Cancel folder')):null;
 const Browser=()=>{const sectionTitle=useSource(window.sectionTitle,x=>x);return React.createElement(component,{...face,wide:useSource(mode,x=>x),expandSidebar:()=>mode.set(true),useSessions:select=>useSource(sessions,select),useWorkspaces:select=>useSource(workspaces,select),useStore:select=>useSource(view,select),actions,useDirectoryFlow:select=>useSource(face.hooks.directoryFlow,select),useHostDescription:select=>useSource(face.hooks.hostDescription,select),renderSlot:(_key,owner)=>Directory(owner),t:(key,args)=>key.startsWith('section.')?sectionTitle:key==='date.ymd'?`${args.y}-${args.m}-${args.d}`:key==='hover.created'?`Created ${args.time}`:key})};window.root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(Browser));
 });const nav=()=>page.locator('[data-xharness-plugin-nav]');await nav().waitFor();await page.evaluate(()=>document.fonts.ready);const initialPixelsSha256=createHash('sha256').update(await page.locator('#root').screenshot({animations:'disabled'})).digest('hex');assert.equal(await nav().count(),1);await nav().click();await page.waitForFunction(()=>document.querySelector('[data-xharness-plugin-nav]').getAttribute('aria-current')==='page');await page.evaluate(()=>window.fixtureShellNavigation?fixtureShellNavigation.close():window.dispatchEvent(new Event('xharness:plugins:closed')));await page.waitForFunction(()=>!document.querySelector('[data-xharness-plugin-nav]').hasAttribute('aria-current'));if(implementation!=='legacy'){
   const searchEntry=page.getByRole('button',{name:'search.sessions.aria',exact:true})
   assert.equal(await searchEntry.count(),0,'removed search does not return in expanded sidebar')
   assert.equal(await page.getByPlaceholder('search.placeholder',{exact:true}).count(),0,'removed search field stays absent')
   // Removing the search seat also removed its auto-margin spacer. The
   // section title must remain at the list's left edge, not drift toward the
   // toolbar; narrow/translated titles shrink rather than clipping controls.
   const headerGeometry=async()=>page.locator('.w3qmIq_sectionHeader').evaluate(header=>{
     const label=header.querySelector('.w3qmIq_sectionLabel'),actions=header.querySelector('.w3qmIq_headerActions')
     const h=header.getBoundingClientRect(),l=label.getBoundingClientRect(),a=actions.getBoundingClientRect()
     return {left:l.left,expected:h.left+parseFloat(getComputedStyle(header).paddingLeft),right:l.right,actionsLeft:a.left,actionsRight:a.right,headerRight:h.right}
   })
   for(const dark of [false,true])for(const width of [220,280,400])for(const title of ['Workspaces','工作区','A very long workspace heading that must not hide the toolbar']){
     await page.evaluate(({dark,width,title})=>{document.body.toggleAttribute('data-ds-dark-theme',dark);document.getElementById('root').style.width=width+'px';sectionTitle.set(title)}, {dark,width,title})
     await page.getByText(title,{exact:true}).waitFor()
     const geometry=await headerGeometry()
     assert.ok(Math.abs(geometry.left-geometry.expected)<1,`workspace title stays left aligned: ${JSON.stringify(geometry)}`)
     assert.ok(geometry.right<=geometry.actionsLeft-3,'workspace title does not overlap toolbar')
     assert.ok(geometry.actionsRight<=geometry.headerRight+1,'workspace toolbar stays in sidebar')
   }
   await page.evaluate(()=>{document.body.removeAttribute('data-ds-dark-theme');document.getElementById('root').style.width='280px';sectionTitle.set('section.workspaces')})
   const workNav=page.locator('[data-xharness-work-nav]')
   assert.equal(await workNav.count(),1)
   for(const selector of ['[data-xharness-work-nav]','[data-xharness-plugin-nav]']) {
     assert.equal(await page.locator(selector).evaluate(node=>{const box=node.getBoundingClientRect(),clip=node.closest('.w3qmIq_headerActions').getBoundingClientRect();return box.left>=clip.left-1&&box.right<=clip.right+1}),true,'both new and old navigation fit the clipped header')
   }
   await workNav.click();await page.waitForFunction(()=>document.querySelector('[data-xharness-work-nav]').getAttribute('aria-current')==='page')
   await page.evaluate(()=>mode.set(false));await workNav.waitFor()
   assert.equal(await searchEntry.count(),0,'removed search does not return in collapsed sidebar')
   assert.equal(await workNav.getAttribute('aria-current'),'page','clock selection survives wide/rail remount')
   await page.evaluate(()=>fixtureShellNavigation.close())
   await page.waitForFunction(()=>!document.querySelector('[data-xharness-work-nav]').hasAttribute('aria-current'))
   await page.evaluate(()=>mode.set(true));await workNav.waitFor()
   assert.equal(await searchEntry.count(),0,'search remains absent after collapsing and expanding again')
   const remountedGeometry=await headerGeometry()
   assert.ok(Math.abs(remountedGeometry.left-remountedGeometry.expected)<1,'workspace title remains left aligned after expanding again')
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('xharness:work:open-session',{detail:'test-open'})))
   assert.deepEqual(await page.evaluate(()=>trace.pop()),['open','test-open'],'Work navigation reaches existing session owner')
  }
  await page.evaluate(()=>mode.set(false));await nav().waitFor();assert.equal(await nav().count(),1);await nav().click();await page.waitForFunction(()=>document.querySelector('[data-xharness-plugin-nav]').getAttribute('aria-current')==='page');await page.getByRole('button',{name:'workspace.add',exact:true}).click();await page.getByRole('dialog',{name:'directory'}).waitFor();await page.getByRole('button',{name:'Use folder',exact:true}).click();await page.waitForFunction(()=>trace.some(x=>x[0]==='start'));assert.deepEqual(await page.evaluate(()=>trace),[['create',{path:'/chosen'}],['start','picked']]);await page.getByRole('button',{name:'workspace.add',exact:true}).click();await page.getByRole('dialog',{name:'directory'}).waitFor();await page.evaluate(()=>flow.set(false));await page.waitForFunction(()=>!document.querySelector('[aria-label="directory"]'));assert.equal(await page.getByRole('button',{name:'workspace.add',exact:true}).count(),0);await page.evaluate(()=>{mode.set(true);workspaces.set({...workspaces.getSnapshot(),items:[{workspaceId:'timestamp',title:'Native timestamp',path:'/timestamp',sessionIds:[],createdAt:'1789192051593',updatedAt:'1789192051593'}]})});await page.getByRole('treeitem').filter({hasText:'Native timestamp'}).hover();await page.getByText(/Created 2026-9-12/).waitFor();await page.evaluate(()=>workspaces.set({...workspaces.getSnapshot(),items:[{workspaceId:'timestamp',title:'Native timestamp',path:'/timestamp',sessionIds:[],createdAt:'invalid',updatedAt:'invalid'}]}));await page.waitForFunction(()=>!Array.from(document.querySelectorAll('[role=tooltip]')).some(el=>el.textContent.includes('Created ')));assert.equal(await page.getByText(/Created /).count(),0);assert.ok(!(await page.locator('#root').innerText()).includes('NaN'));await page.evaluate(()=>{root.unmount();window.closeNavigation?.()});assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,implementation,actualPlatform:true,actualRuntimeEngine:true,initialPixelsSha256,workspaceHeaderAlignment:implementation!=='legacy',wideRailNav:true,currentState:true,directoryAdoption:true,occupantUnload:true,decimalMsHover:true,invalidTimeOmitted:true,pageErrors:errors}));
}finally{await browser.close()}
