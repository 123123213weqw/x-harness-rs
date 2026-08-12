/** Bounded workspace currency / tab semantics from the actual Layout closure. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {layoutUnitModuleTestInput} from './fixtures/layout-module-test-input.mjs'
const exports=['xhLoadBrowserSpaces','xhWorkspaceOpen','xhWorkspaceClose','xhNextWorkspaceId']
if(process.env.UI_TEST_IMPL!=='legacy')exports.push('xhWorkspaceToggle')
const code=layoutUnitModuleTestInput('workspace-pane.js',exports)
let registration
vm.runInNewContext(code,{window:{__ModuleLoader__:{load:row=>registration=row}},URL,console,localStorage:{getItem:()=>null}})
const api=registration.factory(()=>({})),json=value=>JSON.parse(JSON.stringify(value)),item=(id,extra={})=>({id,kind:'browser',source:'browser',title:id,entries:[],position:-1,...extra})
test('layout: latest tab reuse, explicit fresh opening, neighbor selection, missing-close identity',()=>{
 const one={items:[item('browser:1')],activeId:'browser:1'},two=api.xhWorkspaceOpen(one,item('browser:2'))
 assert.deepEqual(json(two),json(one),'kind/source reuse retains original item identity')
 const fresh=api.xhWorkspaceOpen(one,item('browser:2'),false),three=api.xhWorkspaceOpen(fresh,{...item('file:3'),kind:'file',source:'/a'},false)
 assert.equal(three.activeId,'file:3');assert.equal(three.items.length,3)
 const closed=api.xhWorkspaceClose(three,'file:3');assert.equal(closed.activeId,'browser:2')
 assert.equal(api.xhWorkspaceClose(closed,'not-present'),closed)
 assert.equal(api.xhWorkspaceClose({items:[item('browser:1')],activeId:'browser:1'},'browser:1').activeId,null)
})
test('layout: legal saved tabs retain stable ids, only browser data persists, URL credentials/script are excluded',()=>{
 const raw={s:{activeId:'browser:7',items:[item('browser:7',{title:'A'.repeat(161),entries:['https://example.com/','http://localhost:1234/','javascript:bad','https://user:password@example.org/'],position:99}),{...item('tool'),kind:'tool'},{...item('bad.id'),kind:'browser'}]}}
 const parsed=api.xhLoadBrowserSpaces(JSON.stringify(raw))
 assert.equal(parsed.s.items.length,1);assert.equal(parsed.s.items[0].title.length,160)
 assert.deepEqual(json(parsed.s.items[0].entries),['https://example.com/','http://localhost:1234/']);assert.equal(parsed.s.items[0].position,1)
 assert.equal(parsed.s.activeId,'browser:7');assert.equal(api.xhNextWorkspaceId(parsed),7)
 for(const raw of ['{','null','[]','7','"bad"','{}'])assert.deepEqual(json(api.xhLoadBrowserSpaces(raw)),{})
})
test('layout: 50 sessions/128 items/50 addresses remain bounded and selection falls back correctly',()=>{
 const urls=Array.from({length:55},(_,i)=>`https://example.com/${i}`),spaces=Object.fromEntries(Array.from({length:55},(_,n)=>['s'+n,{activeId:'absent',items:Array.from({length:130},(_,i)=>item('browser:'+i,{entries:urls,position:10}))}]))
 const decoded=api.xhLoadBrowserSpaces(JSON.stringify(spaces))
 assert.equal(Object.keys(decoded).length,50);assert.equal(decoded.s0,undefined);assert.equal(decoded.s5.items.length,128)
 const first=decoded.s5.items[0];assert.equal(first.id,'browser:2');assert.equal(first.entries.length,50);assert.equal(first.position,5)
 assert.equal(decoded.s5.activeId,first.id)
})
if(process.env.UI_TEST_IMPL!=='legacy')test('layout: collapse preserves every tab and selection, explicit opening reveals the requested item',()=>{
 const first=item('browser:1',{entries:['https://example.com/'],position:0})
 const tool={...item('tool'),kind:'tool',source:'tool'}
 const original={items:[first,tool],activeId:'tool'}
 const collapsed=api.xhWorkspaceToggle(original)
 assert.equal(collapsed.collapsed,true);assert.equal(collapsed.items,original.items);assert.equal(collapsed.activeId,'tool')
 const reopened=api.xhWorkspaceToggle(collapsed)
 assert.equal(reopened.collapsed,false);assert.equal(reopened.items,original.items);assert.equal(reopened.activeId,'tool')
 const reused=api.xhWorkspaceOpen(collapsed,item('browser:999'))
 assert.equal(reused.collapsed,false);assert.equal(reused.items.length,2);assert.equal(reused.activeId,'browser:1');assert.equal(reused.items[0],first)
 const closed=api.xhWorkspaceClose(collapsed,'tool')
 assert.equal(closed.collapsed,true);assert.equal(closed.activeId,'browser:1')
 const saved=api.xhLoadBrowserSpaces(JSON.stringify({s:collapsed}))
 assert.equal(saved.s.collapsed,undefined,'transient hiding never changes the historical persistence schema')
 assert.equal(saved.s.items.length,1);assert.deepEqual(json(saved.s.items[0].entries),first.entries)
 const empty={items:[],activeId:null};assert.equal(api.xhWorkspaceToggle(empty),empty)
})
