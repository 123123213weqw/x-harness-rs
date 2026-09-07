// Regression of the shipped upstream breadcrumb and navigation implementations.
// Test-only extraction keeps production components unchanged; this is not a second UI.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import vm from 'node:vm'
const base=new URL('../ui/dist/plugins/@deepseek-ai/',import.meta.url)
const conversation=readFileSync(new URL('dsh-client-ui-conversation/client.js',base),'utf8')
const runtime=readFileSync(new URL('dsh-client-runtime/client.js',base),'utf8')
const take=(text,start,end)=>{
 const a=text.indexOf(start), b=text.indexOf(end,a)
 assert.ok(a>=0&&b>a,'upstream navigation contract changed: '+start)
 return text.slice(a,b)
}
const ancestry=take(conversation,'function deriveAncestry(', 'function equalBreadcrumbs(')
const header=take(conversation,'function equalBreadcrumbs(', '\n\t\t/**\n\t\t* Renders the active Session')
const selection=take(runtime,'select(sessionId) {','\n\t\t\t/**\n\t\t\t* Select a healthy child')
const address=take(runtime,'navigationAddress(sessionId) {','\n\t\t\t/**\n\t\t\t* Drop a session instance')
const selectionClass=`class Navigation {${selection}\n${address}}`
const derive=vm.runInNewContext(ancestry+';deriveAncestry')
const ids=list=>Array.from(derive(list,'child'),x=>x.id)
const broken={byId:{parent:{id:'parent',displayTitle:'主 Agent'},child:{id:'child',displayTitle:'子 Agent',parentId:'parent'}}}
assert.deepEqual(ids(broken),['child'],'reproduce missing-origin regression: only disabled current breadcrumb')
const fixed=structuredClone(broken);fixed.byId.child.origin='subagent'
assert.deepEqual(ids(fixed),['parent','child'])
const cycle=structuredClone(fixed);cycle.byId.parent={...cycle.byId.parent,origin:'subagent',parentId:'child'}
assert.deepEqual(ids(cycle),['parent','child'])
const missing=structuredClone(fixed);delete missing.byId.parent;assert.deepEqual(ids(missing),['child'])
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','package.json'))
const {chromium,webkit}=require('playwright');const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await ({chromium,webkit}[engine]).launch({headless:true})
try {
 const page=await browser.newPage();await page.setContent('<div id="header"></div><textarea aria-label="消息"></textarea>')
 for(const file of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests','node_modules',file)})
 await page.addScriptTag({content:`
 const react=React, clsx=(...parts)=>parts.filter(Boolean).join('');
 const react_jsx_runtime={jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key}),Fragment:React.Fragment};
 const ConversationRoot_module_css_default={};
 const resolveActiveView=()=>({id:'chat'});
 ${ancestry}\n${header}\n${selectionClass}
 window.list=${JSON.stringify(fixed)};
 window.manager=new Navigation();Object.assign(manager,{addresses:new Map([['child',{parentSessionId:'parent',childSessionId:'child',mode:'continuable'}]]),summaries:[{sessionId:'parent'},{sessionId:'child'}],catalogs:new Map(),sessions:new Map(),completedNotifications:new Set(),refreshSubagents:()=>{},notifier:{notifyNow:()=>render()}});
 window.root=ReactDOM.createRoot(document.getElementById('header'));
 window.render=()=>{const id=manager.selected;document.querySelector('textarea').dataset.target=id;root.render(React.createElement(ConversationSessionHeader,{sessionId:id,useSession:f=>f({blank:false,composerPhase:'ready'}),useSessions:f=>f(list),useStore:f=>f({view:'chat'}),actions:{setView(){}},renderSlot:()=>null,views:{subscribe:()=>()=>{},version:()=>0,list:()=>[{id:'chat',label:'Chat'}]},open:next=>manager.select(next),t:key=>key}))};
 manager.selected='child';render();
 `})
 const parent=page.getByRole('button',{name:'主 Agent',exact:true})
 await parent.waitFor();assert.equal(await parent.isEnabled(),true)
 assert.equal(await page.getByRole('button',{name:'子 Agent',exact:true}).isDisabled(),true)
 await parent.click();assert.equal(await page.evaluate(()=>manager.selected),'parent')
 assert.equal(await page.locator('textarea').getAttribute('data-target'),'parent')
 assert.equal(await page.evaluate(()=>manager.navigationAddress('parent')),undefined,'parent must not retain child transport address')
 // Repeat child -> parent via keyboard, preserving editable main composer even if child continues running.
 await page.evaluate(()=>{manager.select('child')});await parent.focus();await page.keyboard.press('Enter')
 assert.equal(await page.evaluate(()=>manager.selected),'parent')
 await page.locator('textarea').fill('继续主任务')
 assert.equal(await page.locator('textarea').inputValue(),'继续主任务')
 // Simulate restored summary after reconnect; same ancestry survives.
 await page.evaluate(()=>{list=JSON.parse(JSON.stringify(list));manager.select('child')});await parent.click()
 assert.equal(await page.evaluate(()=>manager.selected),'parent')
 console.log(engine+': missing-origin reproduced; upstream parent breadcrumb click, keyboard and restored navigation passed')
} finally {await browser.close()}
