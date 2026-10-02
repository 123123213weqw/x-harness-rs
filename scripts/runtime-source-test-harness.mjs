/** Shared selection for the old product-history gates and genuine-source entries. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { loadOwnedCordisRuntime } from './fixtures/owned-view-cordis-runtime.mjs'
import { compileSourceModules } from './build-source-modules.mjs'
export const root=fileURLToPath(new URL('../',import.meta.url))
export const runtimeId='@xharness/dsh-client-runtime'
export const conversationId='@xharness/dsh-client-ui-conversation'
export const frozenRuntime=readFileSync(resolve(root,'ui/reference/master-a613970/plugins',runtimeId,'client.js'),'utf8')
export const frozenConversation=readFileSync(resolve(root,'ui/reference/master-a613970/plugins',conversationId,'client.js'),'utf8')
const manifest=JSON.parse(readFileSync(resolve(root,'ui/modules.json'),'utf8'))
const mode=process.env.UI_TEST_IMPL??(manifest.modules.find(row=>row.id===runtimeId)?.kind==='source-module'?'source':'legacy')
assert.ok(['source','legacy'].includes(mode),`Unknown runtime test implementation ${mode}`)
export const sourceMode=mode==='source'
let compiled
export function runtimeTestSource(){
  if(!sourceMode)return frozenRuntime.replace('exports.apply = apply;', 'exports.Session = Session; exports.SessionManager = SessionManager; exports.apply = apply;')
  compiled??=compileSourceModules(resolve(root,'ui'),[{id:runtimeId,source:'src/modules/client-runtime/test-exports.ts'}])
  return compiled.get(runtimeId).bytes.toString()
}
export function conversationBrowserTestSource(){
  if(!sourceMode)return frozenConversation.replace('exports.apply = apply;', 'exports.ChatView = ChatView; exports.registerConversationNodes = registerConversationNodes; exports.apply = apply;')
  return compileSourceModules(resolve(root,'ui'),[{id:conversationId,source:'src/modules/client-runtime/history-browser-exports.ts'}]).get(conversationId).bytes.toString()
}
/** The routed source gate always exercises both the frozen and source implementations. */
export function runFrozenSourceDifferential(pattern){
  if(!sourceMode)return
  const result=spawnSync(process.execPath,['--test',`--test-name-pattern=${pattern}`,resolve(root,'scripts/test-foundation-source-modules.mjs')],{cwd:root,stdio:'inherit',env:process.env})
  assert.equal(result.status,0,'Frozen/source runtime differential failed')
}

/** Real pinned Core + SlotCore, never a fake Service superclass or unknown
 * inheritance face. Private test entries retain their real lexical imports. */
export function runtimeTestApi(globals={}){
 const core=loadOwnedCordisRuntime()
 const evaluate=source=>{
  let registration
  vm.runInNewContext(source,{
   console,URL,AbortController,AbortSignal,Promise,Map,Set,Date,
   setTimeout,clearTimeout,queueMicrotask,
   requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
   ...globals,window:{__ModuleLoader__:{load:value=>{registration=value}}},
  })
  assert.ok(registration,'actual ModuleLoader registration')
  return registration
 }
 const slotId='foundation-acceptance:real-slot-core'
 const slotsEntry=compileSourceModules(resolve(root,'ui'),[{id:slotId,source:'src/modules/platform/slots/index.ts'}]).get(slotId)
 const slots=evaluate(slotsEntry.bytes.toString()).factory(id=>{
  assert.equal(id,'@xharness/cordis','actual SlotCore dependency')
  return core
 })
 return evaluate(runtimeTestSource()).factory(id=>{
  if(id==='@xharness/cordis')return core
  if(id==='@xharness/dsh-client-ui-slots')return slots
  throw Error('Unexpected actual Runtime dependency '+id)
 })
}
