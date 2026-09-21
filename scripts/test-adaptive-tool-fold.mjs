import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compile, harness, json } from './conversation-test-harness.mjs'
import { terminalHarness, terminalRow, terminalEvent } from './session-terminal-test-harness.mjs'
const compiled=compile(),{plugin}=harness(compiled.test)
const row=(key,height=100,extra={})=>({key,turn:1,height,eligible:true,protected:false,...extra})
const plan=(rows,height=500,share)=>[...plugin.planToolFold(rows,height,share)]
const block=(extra={})=>({kind:'tool-result',seq:1,time:1,callId:'x',callView:null,call:null,callTime:null,content:[],isError:false,resultView:null,subCalls:[],...extra})
const tool=root=>({kind:'tool-call',data:{root}})
test('40% budget, oldest first, newest preserved; short and single huge calls stay inspectable',()=>{
 assert.deepEqual(plan([row('a'),row('b')]),[])
 assert.deepEqual(plan([row('a'),row('b'),row('c'),row('d')]),['a','b'])
 assert.deepEqual(plan([row('a',5000)]),[])
 assert.deepEqual(plan([row('a',5000),row('b')]),['a'])
 assert.deepEqual(plan([row('a'),row('b'),row('c')],500,0.6),[])
})
test('pending/error/focus/selection/manual-open/reader-anchor protections override budget',()=>{
 const rows=[row('error',500,{eligible:false}),row('focus',500,{protected:true}),row('safe',500),row('pending',500,{eligible:false})]
 assert.deepEqual(plan(rows),['safe'])
 assert.deepEqual(plan(rows.map(r=>({...r,protected:true}))),[])
})
test('turns isolated, hidden viewport and invalid heights/ratios fail open',()=>{
 assert.deepEqual(plan([row('a'),row('b'),row('c'),row('d',100,{turn:2})]),['a'])
 for(const height of [0,-1,NaN,Infinity])assert.deepEqual(plan([row('a'),row('b'),row('c')],height),[])
 for(const share of [0,-1,NaN,Infinity,1,2])assert.deepEqual(plan([row('a'),row('b'),row('c')],500,share),[])
 assert.deepEqual(plan([row('a',NaN),row('b',Infinity),row('c',-1)]),[])
})
test('recursive calls: only all-successful settled roots eligible, output never mutated',()=>{
 const pending={callId:'p',callView:null,time:1,name:'ask_question',argsRaw:'{}',turn:1,step:1,subCalls:[]}
 for(const root of [pending,block({isError:true}),block({subCalls:[pending]}),block({subCalls:[block({isError:true})]})])assert.equal(plugin.toolCanAutoFold(tool(root)),false)
 const root=block({subCalls:[block({subCalls:[block()]})]}),before=JSON.stringify(root)
 assert.equal(plugin.toolCanAutoFold(tool(root)),true)
 assert.equal(plugin.toolCanAutoFold({kind:'unknown',data:{}}),false)
 assert.equal(JSON.stringify(root),before)
})
test('turn/end folds settled failures but preserves pending/unknown outcomes; expansion restores every row',()=>{
 const tail={turn:1,closing:null}
 for(const root of [block({subCalls:[{callId:'live',subCalls:[]}]}),block({isError:true,error:{name:'OutcomeUnknown',code:'OUTCOME_UNKNOWN'}}),block({subCalls:[block({isError:true,error:{name:'OutcomeUnknown',code:'OUTCOME_UNKNOWN'}})]}),block({isError:true,error:{name:'Interrupted',code:'interrupted'}}),block({subCalls:[block({isError:true,error:{name:'Interrupted',code:'interrupted'}})]})]){
  assert.deepEqual(json(plugin.turnProcessPresentation(tool(root),tail,false)),{collapsed:true,hidden:false})
  assert.deepEqual(json(plugin.turnProcessPresentation(tool(root),tail,true)),{collapsed:false,hidden:false})
 }
 for(const root of [block(),block({isError:true}),block({subCalls:[block({isError:true})]})]){
  const before=JSON.stringify(root)
  assert.deepEqual(json(plugin.turnProcessPresentation(tool(root),tail,false)),{collapsed:true,hidden:true})
  assert.deepEqual(json(plugin.turnProcessPresentation(tool(root),tail,true)),{collapsed:false,hidden:false})
  assert.equal(plugin.turnProcessPresentation(tool(root),undefined,false).hidden,false,'failure never folds before turn/end')
  assert.equal(JSON.stringify(root),before,'folding cannot mutate failure evidence')
 }
})

test('Agent communication stays visible in live and closed turns, also under recursive tools',()=>{
 const agent=block({call:{name:'agent',argsRaw:'{"action":"send","agent_id":"child","message":"clarify"}'},content:[{type:'text',text:'{"ok":true,"status":"accepted"}'}]})
 for(const root of [agent,block({subCalls:[agent]}),block({subCalls:[block({subCalls:[agent]})]})]){
  const before=JSON.stringify(root)
  assert.equal(plugin.toolCanAutoFold(tool(root)),false)
  assert.deepEqual(json(plugin.turnProcessPresentation(tool(root),{turn:1,closing:null},false)),{collapsed:true,hidden:false})
  assert.equal(JSON.stringify(root),before)
 }
 assert.equal(plugin.toolCanAutoFold(tool(block({call:{name:'bash',argsRaw:'{}'}}))),true)
})

test('Actual Session/Assembler keeps agent call identity and acknowledgement in live and history projection',()=>{
 const api=terminalHarness(compiled.test),args=JSON.stringify({action:'send',agent_id:'child',message:'clarification reply'})
 const ack={ok:true,agent_id:'child',message_id:'stable-reply',status:'accepted'}
 const frames=[terminalEvent(0,'turn/start',{turn:1}),terminalEvent(1,'step/start',{turn:1,step:0}),
  terminalEvent(2,'tool/call',{turn:1,step:0,callId:'agent-send',name:'agent',arguments:args}),
  terminalEvent(3,'tool/result',{turn:1,step:0,message:{source:{callId:'agent-send'},content:[{type:'tool-result',content:[{type:'text',text:JSON.stringify({ok:true,content:JSON.stringify(ack),error:'',truncated:false})}],isError:false}]}},true),
  terminalEvent(4,'step/end',{turn:1,step:0}),terminalEvent(5,'turn/end',{turn:1,reason:{kind:'completed'}})]
 for(const mode of ['live','history']){
  const session=api.session()
  if(mode==='history')session.installWindow(frames.map(terminalRow),false)
  else {session.installWindow([],false);session.openState='open';for(const event of frames)session.acceptLiveEvent(event)}
  const chat=session.getSnapshot().chat,node=chat.order.map(key=>chat.nodes.get(key)).find(node=>node.kind==='tool-call')
  assert.ok(node,mode);assert.equal(node.data.root.call.name,'agent');assert.equal(node.data.root.call.argsRaw,args)
  assert.ok(JSON.stringify(node.data.root.content).includes('stable-reply'))
  assert.equal(plugin.toolCanAutoFold(node),false)
  assert.deepEqual(json(plugin.turnProcessPresentation(node,chat.timeline.turns.get(1).data.get('turn-tail'),false)),{collapsed:true,hidden:false})
 }
})
