import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
const require=createRequire(new URL('../ui/package.json',import.meta.url))
const source=readFileSync(new URL('../ui/src/modules/layout/retained-pages.ts',import.meta.url),'utf8')
const code=require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code
const mod={exports:{}};new Function('module','exports',code)(mod,mod.exports)
const {planRetainedPages:plan,RETAINED_PAGE_IDLE_MS:ttl,RETAINED_PAGE_LIMIT:limit}=mod.exports
const file=id=>({id,kind:'file',source:id,title:id,entries:[],position:-1})
const spaces={A:{items:Array.from({length:8},(_,i)=>file('file:'+i)),activeId:'file:0'},B:{items:[file('file:0')],activeId:'file:0'}}
test('only visited pages mount, shell rerenders retain identity, and session keys isolate equal tab IDs',()=>{
 let pages=plan([],spaces,'A','file:0',true,0)
 assert.equal(pages.length,1)
 assert.equal(plan(pages,spaces,'A','file:0',true,10),pages,'visible rerenders cannot churn state')
 pages=plan(pages,spaces,'B','file:0',true,20)
 assert.equal(pages.length,2);assert.notEqual(pages[0].key,pages[1].key)
 assert.deepEqual(pages.map(p=>p.visible),[false,true])
})
test('hiding preserves until idle deadline; explicit close prunes immediately',()=>{
 let pages=plan([],spaces,'A','file:0',true,0)
 pages=plan(pages,spaces,'A','file:0',false,ttl*2)
 assert.equal(pages.length,1,'a long visible visit starts its idle clock on hide')
 assert.equal(plan(pages,spaces,'A','file:0',false,ttl*3-1).length,1)
 assert.equal(plan(pages,spaces,'A','file:0',false,ttl*3).length,0)
 assert.equal(plan(pages,{A:{items:[],activeId:null}},'A',null,false,ttl*2).length,0)
})
test('LRU budget never evicts the visible page; tools and provisional model tabs cannot opt in',()=>{
 let pages=[]
 for(let i=0;i<8;i++)pages=plan(pages,spaces,'A','file:'+i,true,i)
 assert.equal(pages.length,limit);assert.equal(pages.at(-1).id,'file:7')
 const other={A:{items:[{...file('tool'),kind:'tool'},{...file('pending'),kind:'browser',modelRequestId:'request'}],activeId:'tool'}}
 assert.equal(plan([],other,'A','tool',true,0).length,0)
 const provisional=plan([],other,'A','pending',true,0);assert.equal(provisional.length,1)
 assert.equal(plan(provisional,other,'A','pending',false,1).length,0,'provisional tab unmounts immediately on hide')
})
