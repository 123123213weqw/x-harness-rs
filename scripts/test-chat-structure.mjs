import assert from 'node:assert/strict'
import {test} from 'node:test'
import {compile,harness} from './conversation-test-harness.mjs'
import {exposeModuleUnit} from './fixtures/module-unit-scope.mjs'
const {entry}=compile()
const {plugin}=harness(exposeModuleUnit(entry,'conversation','conversation-nodes/chat-snapshot-builder','MutableChatNodeStore'))
const node=(key,turn=1)=>({key,kind:'assistant-step',visibility:'visible',anchorSeq:turn,location:{kind:'turn',turn:{turn}},data:{text:'a'}})
test('content and status updates never invalidate the structural index, at 2000 and 5000 turns',()=>{
 for(const count of [2000,5000]){
  const store=new plugin.MutableChatNodeStore(),rows=Array.from({length:count},(_,i)=>node(String(i),i+1))
  store.replace(rows);const version=store.structureVersion
  for(let i=0;i<120;i++)store.upsert([{...rows.at(-1),location:{...rows.at(-1).location,turn:{turn:count,status:'open'}},data:{text:'a'.repeat(i+1)}}])
  assert.equal(store.structureVersion,version)
  store.upsert([{...rows.at(-1),anchorSeq:count+1}]);assert.ok(store.structureVersion>version)
  const changed=store.structureVersion
  store.upsert([node('new',count+1)]);assert.ok(store.structureVersion>changed)
  const added=store.structureVersion
  store.upsert([{...rows[0],location:{kind:'turn',turn:{turn:99999}}}]);assert.ok(store.structureVersion>added)
 }
})
test('replace invalidates even when keys are equal, preserving cold-recovery and prepend safety',()=>{
 const store=new plugin.MutableChatNodeStore();store.replace([node('a')]);const first=store.structureVersion
 store.replace([node('a',2)]);assert.ok(store.structureVersion>first)
 const second=store.structureVersion;store.upsert([{...node('a',2),kind:'user'}]);assert.ok(store.structureVersion>second)
})
