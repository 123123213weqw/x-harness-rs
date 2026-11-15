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
test('turn/end folds success but preserves failures/pending/unknown outcomes; expansion restores every row',()=>{
 const tail={turn:1,closing:null}
 for(const root of [block({isError:true}),block({subCalls:[block({isError:true})]}),block({subCalls:[{callId:'live',subCalls:[]}]}),block({isError:true,error:{name:'OutcomeUnknown',code:'OUTCOME_UNKNOWN'}}),block({subCalls:[block({isError:true,error:{name:'OutcomeUnknown',code:'OUTCOME_UNKNOWN'}})]}),block({isError:true,error:{name:'Interrupted',code:'interrupted'}}),block({subCalls:[block({isError:true,error:{name:'Interrupted',code:'interrupted'}})]})]){
  assert.deepEqual(json(plugin.turnProcessPresentation(tool(root),tail,false)),{collapsed:true,hidden:false})
  assert.deepEqual(json(plugin.turnProcessPresentation(tool(root),tail,true)),{collapsed:false,hidden:false})
 }
 for(const root of [block(),block({subCalls:[block()]})]){
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

test('compact mode folds earlier success even below the old budget, but newest/protected/hidden viewport remain safe',()=>{
 const rows=[row('first',24),row('focused',24,{protected:true}),row('last',24)]
 assert.deepEqual([...plugin.planToolFold(rows,1000,0.4,true)],['first'])
 assert.deepEqual([...plugin.planToolFold(rows,0,0.4,true)],[])
 for(const root of [block({resultView:{card:'terminal',exitCode:7}}),block({resultView:{card:'terminal',signal:'SIGTERM'}}),block({subCalls:[block({resultView:{card:'terminal',exitCode:1}})]})]){
  assert.equal(plugin.toolCanAutoFold(tool(root)),false)
  assert.equal(plugin.turnProcessPresentation(tool(root),{turn:1,closing:null},false).hidden,false)
 }
})
test('live reasoning is grouped without hiding prose, images, preparing inputs, unknown blocks or interruption',()=>{
 const assistant=(blocks,status='running')=>({kind:'assistant-step',data:{blocks,status}})
 const present=node=>json(plugin.turnProcessPresentation(node,undefined,false,true))
 assert.deepEqual(present(assistant([{kind:'reasoning',text:'thinking'}])),{collapsed:true,hidden:true})
 for(const blocks of [[{kind:'text',text:'visible narration'}],[{kind:'image',attachment:{}}],[{kind:'other',block:{}}],[{kind:'tool-call',callId:'x',name:'edit',argsRaw:'{"path":'}]])assert.deepEqual(present(assistant(blocks)),{collapsed:true,hidden:false})
 assert.deepEqual(present(assistant([{kind:'reasoning',text:'stopped'}],'interrupted')),{collapsed:true,hidden:false})
 assert.deepEqual(json(plugin.turnProcessPresentation(assistant([{kind:'reasoning',text:'thinking'}]),undefined,true,true)),{collapsed:false,hidden:false})
 assert.equal(present(tool(block({isError:true}))).hidden,false)
})
test('loaded-window counts deduplicate subcalls and never mutate or retain a second transcript',()=>{
 const assistant={key:'a',kind:'assistant-step',data:{turn:1,step:0,time:1,status:'running',blocks:[{kind:'reasoning',text:'summary'},{kind:'text',text:'answer'}]}}
 const one={key:'t',...tool(block({callId:'root',subCalls:[block({callId:'child'})]}))}
 const child={key:'c',...tool(block({callId:'child'}))}
 const nodes=new Map([['a',assistant],['t',one],['c',child],['unknown',{kind:'extension',data:{}}]])
 const before=JSON.stringify([...nodes]);const count=keys=>json(plugin.turnProcessCounts(keys,key=>nodes.get(key)))
 assert.deepEqual(count(['a','t','c','unknown','missing']),{tools:2,thoughts:1})
 assert.deepEqual(count(['c']),{tools:1,thoughts:0},'partial windows do not count unloaded roots')
 assert.deepEqual(count(['a','t','c']),{tools:2,thoughts:1},'cached immutable metadata remains exact')
 nodes.set('a',{...assistant,data:{...assistant.data,blocks:[...assistant.data.blocks,{kind:'reasoning',text:'later'}]}})
 assert.deepEqual(count(['a']),{tools:0,thoughts:2},'new immutable streaming node invalidates metadata')
 nodes.set('a',assistant);assert.equal(JSON.stringify([...nodes]),before)
})

test('tool counts namespace call IDs by owning step, not a globally unique model-generated ID',()=>{
 const location=step=>({kind:'step',turn:{turn:1},step:{step}})
 const first={key:'one',...tool(block({callId:'reused'})),location:location(0)}
 const second={key:'two',...tool(block({callId:'reused'})),location:location(1)}
 const nodes=new Map([['one',first],['two',second]])
 assert.deepEqual(json(plugin.turnProcessCounts(['one','two'],key=>nodes.get(key))),{tools:2,thoughts:0})
})

const activityItem=(key,summary=key,name='read')=>({key,name,title:name,summary})
const activity=(items,parallel=items.length)=>({items,parallel,blocked:false})
const projectActivity=nodes=>json(plugin.decodeToolActivity(plugin.selectToolActivity(nodes.map(n=>n.key),key=>nodes.find(n=>n.key===key))))
const activeNode=(id,seq,extra={})=>({key:id,kind:'tool-call',anchorSeq:seq,location:{kind:'step',turn:{turn:1},step:{step:1}},data:{root:{callId:id,name:'read',argsRaw:'{"path":"'+id+'"}',turn:1,step:1,time:seq,callView:null,subCalls:[],...extra}}})
const returnedNode=(id,seq,extra={})=>{const n=activeNode(id,seq);return{...n,data:{root:block({callId:id,seq:seq+1,call:{name:'read',argsRaw:'{"path":"'+id+'"}'},...extra})}}}
test('Tool activity pacing: one latest input, fixed deadline, 180ms expiry and no replay queue',()=>{
 const model=new plugin.ToolActivityPresentation(),a=activityItem('a'),b=activityItem('b'),c=activityItem('c')
 model.reset(activity([a],0),0)
 model.update(activity([b],0),100,true);assert.equal(model.nextAt,1000)
 model.update(activity([c],0),900,true);assert.equal(model.nextAt,1000,'stream updates never postpone the original deadline')
 model.advance(999,true);assert.equal(model.frame.current.key,'a')
 model.advance(1000,true);assert.equal(model.frame.current.key,'c');assert.equal(model.frame.previous.key,'a');assert.equal(model.nextAt,1180)
 model.advance(1180,true);assert.equal(model.frame.previous,undefined);assert.equal(model.nextAt,undefined)
 assert.equal(plugin.TOOL_ACTIVITY_PAGE_MS,1000);assert.equal(plugin.TOOL_ACTIVITY_FLIP_MS,180)
})
test('Tool activity pacing: parallel cycles current roots, late callbacks skip backlog and duplicate faces do not flip',()=>{
 const model=new plugin.ToolActivityPresentation(),items=['a','b','c'].map(key=>activityItem(key))
 model.reset(activity(items),0);assert.equal(model.frame.current.key,'c')
 model.advance(1000,true);assert.equal(model.frame.current.key,'a')
 model.update(activity([items[1],items[2]]),1100,true)
 model.advance(10000,true);assert.equal(model.frame.current.key,'c');assert.equal(model.nextAt,10180)
 model.advance(10180,true);assert.equal(model.nextAt,11000)
 const first=activityItem('x','same'),second=activityItem('y','same')
 model.reset(activity([first],0),0);model.update(activity([second],0),10,true);model.advance(1000,true)
 assert.equal(model.frame.current.key,'y');assert.equal(model.frame.previous,undefined,'identity alone never animates identical text')
})
test('Tool activity pacing: blocks clear both faces immediately, freeze and reset have no stale backlog',()=>{
 const model=new plugin.ToolActivityPresentation()
 model.reset(activity([activityItem('a')],0),0);model.update(activity([activityItem('b')],0),50,true);model.advance(1000,true)
 assert.ok(model.frame.previous)
 model.update({items:[],parallel:0,blocked:true},1010,true)
 assert.equal(model.frame.current,undefined);assert.equal(model.frame.previous,undefined);assert.equal(model.nextAt,undefined)
 model.reset(activity([activityItem('fresh')]),2000);model.freeze();assert.equal(model.nextAt,undefined)
 model.reset(activity([activityItem('new')]),9000);assert.equal(model.frame.current.key,'new');assert.equal(model.frame.previous,undefined)
})
test('Tool activity projection: only active root invocations count as parallel, reused IDs keep scope and raw data stays exact',()=>{
 const a=activeNode('a',1),b=activeNode('b',2),c=activeNode('c',3),raw=JSON.stringify([a,b,c])
 let p=projectActivity([a,b,c]);assert.equal(p.parallel,3);assert.equal(p.items.length,3)
 const nested=activeNode('parent',1,{subCalls:[activeNode('child',2).data.root]})
 p=projectActivity([nested]);assert.equal(p.parallel,1,'parent and child are not independent parallel roots')
 const again={...b,location:{kind:'step',turn:{turn:1},step:{step:2}}}
 p=projectActivity([a,again]);assert.notEqual(p.items[0].key,p.items[1].key)
 assert.equal(JSON.stringify([a,b,c]),raw)
})
test('Tool activity projection: source failure, nonzero/signal, interruption, missing heads and waiting fail quiet without changing cards',()=>{
 for(const extra of [{isError:true},{error:{code:'OUTCOME_UNKNOWN',name:'Unknown'}},{error:{code:'interrupted',name:'Cancelled'}},{resultView:{card:'terminal',exitCode:1}},{resultView:{card:'terminal',signal:'SIGTERM'}}]){
  const failed=returnedNode('bad',5,extra),raw=JSON.stringify(failed)
  assert.equal(projectActivity([activeNode('old',1),failed]).blocked,true)
  assert.equal(projectActivity([failed,activeNode('recovery',9)]).blocked,false,'a genuinely later dispatch may resume the preview')
  assert.equal(JSON.stringify(failed),raw)
 }
 assert.equal(projectActivity([activeNode('q',1,{name:'ask_question'})]).blocked,true)
 assert.equal(projectActivity([returnedNode('missing',1,{call:null})]).items.length,0)
 assert.equal(projectActivity([{...activeNode('x',1),data:{root:{broken:true}}}]).blocked,true)
})
test('Tool activity projection: bounded recent-root window, unknown names, partial input and display-only MCP identity',()=>{
 const nodes=Array.from({length:100},(_,i)=>activeNode('id'+i,i))
 let p=projectActivity(nodes);assert.equal(p.parallel,100);assert.equal(p.items.length,8)
 for(const name of ['constructor','__proto__',' read ','read'+' '.repeat(1000)]){
  p=projectActivity([activeNode('x',1,{name})]);assert.ok(p.items[0].title.length<=64);assert.notEqual(p.items[0].name,'read')
 }
 p=projectActivity([activeNode('x',1,{argsRaw:'{'} )]);assert.equal(p.items[0].summary,'')
 p=projectActivity([activeNode('x',1,{argsRaw:'x'.repeat(20000)})]);assert.equal(p.items[0].summary,'')
 p=projectActivity([activeNode('x',1,{name:'plugin_mcp',argsRaw:JSON.stringify({action:'call',plugin:'@xharness/native-browser',server:'webview',arguments:{action:'snapshot',private:'not retained'}})})]);assert.equal(p.items[0].title,'Browser');assert.ok(!p.items[0].glyphArgs.includes('private'));assert.equal(p.items[0].summary,'snapshot')
 p=projectActivity([activeNode('x',1,{argsRaw:JSON.stringify({path:'🧠'.repeat(1000)})})]);assert.equal([...p.items[0].summary].length,160);assert.ok(JSON.stringify(p).length<16384)
 for(const value of ['','{','null','[]','x'.repeat(20000),JSON.stringify({items:[],parallel:-1,blocked:false})])assert.deepEqual(json(plugin.decodeToolActivity(value)),{items:[],parallel:0,blocked:false})
})
