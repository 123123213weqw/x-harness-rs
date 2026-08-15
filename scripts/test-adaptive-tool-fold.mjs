import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compile, harness, json } from './conversation-test-harness.mjs'
const {plugin}=harness(compile().test)
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
