import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { patchAgentPresetUi } from './patch-agent-preset-ui.mjs'
import { assertRebuildInput } from './fixtures/repository-ui-input.mjs'

const dist = resolve(process.env.UI_TEST_DIST ?? 'ui/dist')
const id = '@xharness/dsh-client-ui-agent-preset'
const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json'), 'utf8'))
const bytes = readFileSync(resolve(dist, 'plugins', id, 'client.js'))
const source = bytes.toString()
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const entry = graph.entries.find(item => item.id === id)

assert.ok(entry, 'Agent runtime bundle remains loaded')
assert.equal(entry.rev, hash(bytes))
assert.equal(graph.rev, hash(Buffer.from(JSON.stringify(graph.entries))))
// The frozen product remains a golden patch-idempotence/fail-closed fixture.
// Native source is executed below: it must not pass merely because its new
// transpiler output no longer matches the old double-quoted slot regexes.
const frozen = readFileSync(resolve('ui/reference/master-a613970/plugins', id, 'client.js'))
assert.equal(patchAgentPresetUi(id, frozen).toString(), frozen.toString(), 'frozen product patch is idempotent')
assert.throws(() => patchAgentPresetUi(id, Buffer.from('// changed anchor')), /hero chooser anchor/, 'golden patch remains fail-closed')
assert.equal(patchAgentPresetUi('@xharness/other', frozen), frozen, 'unrelated module is untouched')
if (!source.startsWith('// Generated from src/modules/')) assert.equal(patchAgentPresetUi(id, bytes).toString(), source, 'classic patch is idempotent')
assert.doesNotMatch(source, /scope\.slots\.register\(\{\s*name: "conversation\.hero\.agentPreset"/)
assert.doesNotMatch(source, /scope\.slots\.register\(\{\s*name: "conversation\.session\.header\.actions",\s*id: "agent-preset"/)
assert.doesNotMatch(source, /ctx\.slots\.inject\("settings\.general\.item"/)
assert.doesNotMatch(source, /ctx\.slots\.inject\("settings\.section"/)
assert.match(source, /AgentPresetSeatController/, 'runtime and existing preset state are retained')
function observable(initial) {
  let value=initial;const listeners=new Set()
  return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=typeof next==='function'?next(value):next;listeners.forEach(fn=>fn())}}
}
function materialize(text) {
  let registration
  vm.runInNewContext(text,{window:{__ModuleLoader__:{load:value=>{registration=value}}},console,Error,setTimeout,clearTimeout})
  const jsx=(type,props,key)=>({type,props,key})
  return registration.factory(name=>{
    if(name==='react')return {useState:value=>[value,()=>{}],useEffect:()=>{},useMemo:fn=>fn(),useCallback:fn=>fn,useRef:value=>({current:value})}
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'}
    if(name==='@xharness/dsh-client-ui-primitives')return new Proxy({},{get:(_target,key)=>String(key)})
    if(name==='@xharness/dsh-client-runtime/client')return {createSnapshotStore:observable}
    throw Error(`unexpected hidden-agent-mode external ${name}`)
  })
}
async function hiddenModeReceipt(plugin) {
  const registrations=[],effects=[],events=new Map(),eventNames=[],notes=[],sessionListeners=new Set(),dicts=[];let rosterReads=0
  const subscribe=(name,listener)=>{eventNames.push(name);const group=events.get(name)??new Set();group.add(listener);events.set(name,group);return()=>group.delete(listener)}
  const describe={getSnapshot:()=>({status:'ready',view:{writable:false},error:null}),ensure:async()=>{},subscribe:()=>()=>{}}
  const api={agentPresets:{list:async()=>{rosterReads++;return {result:{ok:true,value:{presets:[{id:'default',trust:'system',isDefault:true}],authorable:true,hasDocument:false}}}}}}
  const ctx={get:()=>({api}),settingsScope:{describe:()=>describe},effect:fn=>{const value=fn();if(typeof value==='function')effects.push(value)},locale:{register:(...args)=>{dicts.push(args);return()=>{}},bind:()=>key=>key},remote:{$on:subscribe},on:subscribe,inject:(_names,fn)=>fn(ctx),sessions:{list:{getSnapshot:()=>({byId:{}}),subscribe:fn=>{sessionListeners.add(fn);return()=>sessionListeners.delete(fn)}},noteAgentPreset:(...args)=>notes.push(args)},workspaces:{startSession(){}},slots:{inject:(_name,fn)=>fn(),register:spec=>{registrations.push(spec);return()=>{}}}}
  plugin.apply(ctx)
  assert.equal(registrations.length,0,'native plugin registers none of hero chooser, header label, General row or settings section')
  assert.equal(sessionListeners.size,1,'hidden UI retains its staged-selection session flow controller')
  for(const fn of events.get('agent-preset/selected'))fn('s','existing')
  assert.deepEqual(notes,[['s','existing']],'existing Host agent preset selections are still folded into session state')
  for(const fn of events.get('settings/document-updated'))fn('unrelated')
  assert.equal(rosterReads,0,'unrelated settings do not touch this roster')
  for(const fn of events.get('settings/document-updated'))fn('agent-presets')
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(rosterReads,2,'both deployment-default and staged-seat roster readers remain live')
  effects.forEach(dispose=>dispose())
  assert.equal(sessionListeners.size,0,'native hidden controller releases subscriptions')
  assert.equal(Array.from(events.values()).reduce((total,set)=>total+set.size,0),0,'event forwarding subscriptions are released')
  return JSON.parse(JSON.stringify({registrations,eventNames,notes,dicts,rosterReads}))
}
const golden=await hiddenModeReceipt(materialize(frozen.toString()))
const native=await hiddenModeReceipt(materialize(source))
assert.deepEqual(native,golden,'native hidden-mode behavior matches frozen product, not raw bundle text')
assertRebuildInput(id)
console.log('agent preset UI: frozen golden patch guards + native hidden-mode slots/events/Host selection/roster/cleanup and repository rebuild input passed')
