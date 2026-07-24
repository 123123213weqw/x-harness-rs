import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compile, harness, json } from './conversation-test-harness.mjs'
import { testHooks, descendants } from './conversation-test-hooks.mjs'

const hooks = testHooks()
const { plugin } = harness(compile().test, hooks)
const t = (key, args) => plugin.en[key]?.replace(/\{(\w+)\}/g, (_, k) => args[k]) ?? key
const blocks=[{kind:'reasoning',text:'reasoning'},{kind:'text',text:'answer'}]
const answer={status:'settled',turn:1,step:1,blocks,finalNode:{kind:'assistant',turn:1,step:1,seq:20,time:2000,blocks},time:2000}
const tail = { turn:1,seq:25,time:165000,closing:answer,branchUnavailable:false }
const node = (kind,data={}) => ({key:kind,kind,data})

test('only turn/end tail folds work; step completion and session idle do not', () => {
  for (const kind of ['tool-call','model-retry','assistant-step','context','compaction']) {
    assert.deepEqual(json(plugin.turnProcessPresentation(node(kind,answer), undefined, false)),{collapsed:false,hidden:false})
  }
  const turn={turn:1,status:'open',steps:[{data:new Map([['assistant-step',answer]])}],data:new Map()}
  const end={event:{type:'step/end',seq:25,time:165000,data:{turn:1,step:1}},location:{kind:'step',turn},role:'update'}
  const context={state:{turn:1},matches:[end],start:undefined}
  assert.equal(plugin.turnTailDefinition.buildLocationData(context,'turn'),null,'a finalized step is not an authoritative turn end')
})
test('completed work folds, final answer and every terminal notice remain', () => {
  for (const kind of ['tool-call','model-retry','context','compaction']) {
    assert.equal(plugin.turnProcessPresentation(node(kind),tail,false).hidden,true)
    assert.equal(plugin.turnProcessPresentation(node(kind),tail,true).hidden,false)
  }
  assert.equal(plugin.turnProcessPresentation(node('assistant-step',answer),tail,false).hidden,false)
  assert.equal(plugin.turnProcessPresentation(node('assistant-step',{...answer,finalNode:{seq:10}}),tail,false).hidden,true)
  for (const kind of ['user','steering','command','manual-compaction','turn-tail','turn-error','turn-max-tokens','run-checkpoint','unknown']) {
    assert.equal(plugin.turnProcessPresentation(node(kind),tail,false).hidden,false)
  }
})
test('reasoning/tool-only turns still fold; expanding never deletes original blocks', () => {
  const empty = {...tail,closing:null},original=JSON.stringify(empty)
  assert.equal(plugin.turnProcessPresentation(node('assistant-step',answer),empty,false).hidden,true)
  assert.equal(plugin.turnProcessPresentation(node('tool-call'),empty,false).hidden,true)
  assert.equal(plugin.turnProcessPresentation(node('turn-tail'),empty,false).hidden,false)
  assert.equal(JSON.stringify(empty),original)
})
test('final answer hides reasoning only when folded; original block sequence unchanged', () => {
  const original=JSON.stringify(answer.blocks)
  for(const hideReasoning of [false,true]) {
    hooks.reset()
    const tree=hooks.render(()=>plugin.AssistantMarkdown({blocks:answer.blocks,streaming:false,hideReasoning,renderMessageImages:()=>null,t}))
    assert.equal(descendants(tree,n=>n.type==='MarkdownText').length,1)
    assert.equal(descendants(tree,n=>typeof n.type==='function'&&n.type.name==='ReasoningRow').length,hideReasoning?0:1)
  }
  assert.equal(JSON.stringify(answer.blocks),original)
})
test('footer is independent of正文, always a disclosure with whole-turn duration', () => {
  for (const closing of [answer,null]) for(const hasStart of [true,false]) for(const expanded of [true,false]) {
    hooks.reset()
    const turn={turn:1,start:hasStart?{time:0}:undefined,end:{time:165000},data:new Map()}
    let toggled=0
    const tree=hooks.render(()=>plugin.TurnProcessSummary({turn,data:{...tail,closing},t,collapsed:!expanded,onToggle:()=>toggled++}))
    const button=descendants(tree,n=>n.type==='button'&&n.props['data-turn-process-summary']===1)[0]
    assert.ok(button);assert.equal(button.props['aria-expanded'],expanded)
    assert.equal(button.props.children[0].props.children,hasStart?'Ran for 2m 45s':'Turn finished')
    assert.match(button.props['aria-label'],hasStart?/Ran for 2m 45s/:/Turn finished/)
    button.props.onClick();assert.equal(toggled,1)
  }
})
test('tail projection preserves image-only answers and has same live/replayed end facts', () => {
  const def=plugin.turnTailDefinition
  for (const blocks of [answer.blocks,[{kind:'image',attachment:{attachmentId:'result',mediaType:'image/png',bytes:3,name:'result.png'}}],[{kind:'other',block:{type:'foreign',value:'kept'}}],[{kind:'reasoning',text:'thinking only'}],[]]) {
    const final={...answer,blocks,finalNode:{...answer.finalNode,blocks}},turn={turn:1,steps:[{data:new Map([['assistant-step',final]])}],data:new Map()}
    const end={event:{type:'turn/end',seq:25,time:165000,data:{turn:1,reason:{kind:'stop'}}},location:{kind:'turn',turn},role:'update'}
    const ctx={state:{turn:1},matches:[end],start:undefined}
    const replay=def.buildLocationData(ctx,'turn').value
    const live=def.buildLocationData({...ctx,state:def.update(ctx,end)},'turn').value
    assert.deepEqual(json(live),json(replay))
    assert.equal(live.closing===null,blocks.length===0||blocks[0].kind==='reasoning'&&blocks.length===1)
  }
})
test('last content-bearing output remains final across later empty steps and abnormal endings', () => {
  const blocks=[{kind:'image',attachment:{attachmentId:'result',mediaType:'image/png',bytes:3}}]
  const image={...answer,blocks,finalNode:{...answer.finalNode,blocks}}
  const empty={...answer,blocks:[],finalNode:{...answer.finalNode,seq:30,blocks:[]}}
  const earlier={...answer,finalNode:{...answer.finalNode,seq:10}}
  for(const kind of ['stop','aborted','max-tokens','max-steps','error']) {
    const turn={turn:1,steps:[earlier,image,empty].map(value=>({data:new Map([['assistant-step',value]])})),data:new Map()}
    const end={event:{type:'turn/end',seq:35,time:165000,data:{turn:1,reason:{kind}}},location:{kind:'turn',turn},role:'update'}
    const result=plugin.turnTailDefinition.buildLocationData({state:{turn:1},matches:[end]},'turn').value
    assert.equal(result.closing,image,'immutable image output, not the last empty step, is retained')
    assert.equal(result.branchUnavailable,true,'later evidence keeps original fork protection')
    assert.equal(plugin.turnProcessPresentation(node('assistant-step',earlier),result,false).hidden,true)
    assert.equal(plugin.turnProcessPresentation(node('assistant-step',image),result,false).hidden,false)
    assert.equal(plugin.turnProcessPresentation(node('assistant-step',empty),result,false).hidden,true)
  }
})
