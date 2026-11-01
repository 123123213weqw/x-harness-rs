// Native producer -> actual Runtime/Assembler -> actual turn-tail selector.
// Tool payloads are controlled Rust fixtures; NO test constructs render views.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
import {compile,harness,json} from './conversation-test-harness.mjs'
import {terminalHarness} from './session-terminal-test-harness.mjs'

const path=process.argv[2]??process.env.XHARNESS_PRODUCED_FILES_WIRE??'protocol/fixtures/produced-files-wire.json'
const fixture=JSON.parse(readFileSync(resolve(path),'utf8'))
assert.equal(fixture.schema,1)
const {runtime,conversation:base}=terminalHarness(compile().test)
const id='@xharness/dsh-client-ui-deliverables'
const source=compileSourceModules(resolve('ui'),[{id,source:'src/modules/deliverables/index.ts'}]).get(id).bytes.toString()
const {plugin}=harness(source,{runtime})
let definition,slot
plugin.apply({
 get:name=>name==='connection'?{rpc:()=>{throw Error('wire test must not inspect files')}}:{list:{getSnapshot:()=>({byId:{}})}},
 conversationEvents:{register:value=>{definition=value}},
 locale:{register:()=>{},bind:()=>key=>key},effect:fn=>fn(),provide:()=>{},
 slots:{inject:(_name,fn)=>fn(),register:spec=>{slot=spec}},
})
assert.ok(definition);assert.ok(slot)
const conversation={events:{entries:()=>[...base.events.entries(),definition],fallbackEntry:()=>base.events.fallbackEntry()},views:base.views}
const session=()=>new runtime.Session('file-wire-fixture',{}, {},{conversation})
function paths(value,turnId=0){
 const chat=value.getSnapshot().chat,turn=chat.timeline.turns.get(turnId)
 assert.ok(turn,'actual assembled turn')
 const tail=chat.nodes.values().find(node=>node.kind==='turn-tail'&&node.data.turn===turnId)
 assert.ok(tail,'actual turn-tail node')
 const owner={turn,seq:tail.data.closing?.finalNode.seq??tail.data.seq,openFile:()=>{throw Error('no file opening in wire acceptance')}}
 return json(slot.select(owner))
}
function installed(entries){const s=session();s.installWindow(entries,false);return s}

test('real native mux, history and reopened JSONL expose the same file cards',()=>{
 const comparable=entries=>entries.map(entry=>{const row=structuredClone(entry);if(row.event.type==='request/header')row.event.data.header.options.auditSnapshot=null;return row})
 assert.deepEqual(fixture.live,fixture.history)
 assert.deepEqual(comparable(fixture.history),comparable(fixture.restart))
 const live=session();live.installWindow([],false);live.openState='open'
 for(const row of fixture.live)live.acceptLiveEvent(row.event,row.view)
 for(const value of [live,installed(fixture.history),installed(fixture.restart)]){
  assert.deepEqual(paths(value),fixture.expectedPaths)
  assert.equal(paths(value,1),null,'files must not leak to the next read-only turn')
  const turn=value.getSnapshot().chat.timeline.turns.get(0)
  assert.equal(turn.status,'closed')
  const produced=json(turn.data.get('deliverables').produced)
  assert.equal(produced[0].change,'created','native JSON output envelope metadata is understood')
  assert.equal(produced.find(item=>item.path==='updated.txt').change,'modified')
  assert.equal(produced.find(item=>item.path==='edited.txt').change,undefined,'do not invent a status absent from native evidence')
 }
})

test('the prior native producer gap cannot pass this gate',()=>{
 const noViews=fixture.live.map(row=>({event:row.event}))
 assert.equal(paths(installed(noViews)),null,'successful raw writes alone do not fabricate file cards')
 const calls=fixture.live.filter(row=>row.event.type==='tool/call'&&['write','edit'].includes(row.event.data.name))
 assert.equal(calls.length,6)
 assert.ok(calls.every(row=>row.view?.view.kind==='edit'&&row.view.view.locations.length===1))
 assert.ok(fixture.live.filter(row=>row.event.type==='tool/call'&&!['write','edit'].includes(row.event.data.name)).every(row=>row.view?.view.kind!=='edit'))
})

test('successful settlement, not call/prose/filename-like shell output, creates a card',()=>{
 const first=fixture.live.findIndex(row=>row.event.type==='tool/result')
 const s=session();s.installWindow(fixture.live.slice(0,first),false)
 const before=s.getSnapshot().chat.timeline.turns.get(0).data.get('deliverables')
 assert.deepEqual(json(plugin.producedForClosing(before)),[])
 s.openState='open';s.acceptLiveEvent(fixture.live[first].event,fixture.live[first].view)
 assert.deepEqual(json(plugin.producedForClosing(s.getSnapshot().chat.timeline.turns.get(0).data.get('deliverables'))),['reports/报告.md'])
 assert.ok(!fixture.expectedPaths.some(path=>['failed.txt','uncertain.txt','read-only.txt','not-an-artifact.pdf'].includes(path)))
})

test('a result-only page does not invent an unobserved prefix; loading older evidence restores the card',()=>{
 const s=session();s.installWindow(fixture.partial,true)
 const turn=s.getSnapshot().chat.timeline.turns.get(0)
 assert.deepEqual(json(plugin.producedForClosing(turn?.data.get('deliverables'))),[])
 s.installWindow(fixture.prefix,false)
 assert.deepEqual(json(plugin.producedForClosing(s.getSnapshot().chat.timeline.turns.get(0).data.get('deliverables'))),['reports/报告.md'])
 s.installWindow(fixture.history,false)
 assert.deepEqual(paths(s),fixture.expectedPaths)
})
