import {sharedVendors} from './fixtures/shared-source-vendors.mjs'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {stripReviewedJobStyle} from './fixtures/reviewed-job-ui-contract.mjs'
import {compileSourceModules} from './build-source-modules.mjs'
const id='@xharness/dsh-client-ui-tool',compiled=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id,source:'src/modules/tool/index.ts'},{id:id+'/test',source:'src/modules/tool/test-exports.ts'},{id:'path',source:'src/modules/client-runtime/workspaces/path.ts'}]);const frozen=readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8');const names=['classifyTool','resultText','relativizeToCwd','toolRowModel','terminalBlockLabels','terminalFailed','terminalCardModel','readCardModel','diffCardModel','searchCardModel','webCardModel','ToolRow','BashRow','GenericToolCard','ToolDetails','ToolCallTree'];const json=x=>JSON.parse(JSON.stringify(x,(_k,v)=>typeof v==='function'?`function:${v.name}`:v));let path;vm.runInNewContext(compiled.get('path').bytes.toString(),{window:{__ModuleLoader__:{load:row=>{path=row.factory()}}}})
function harness(code){let row;const styles=[],slots=[],plugins=[];const document={documentElement:{dataset:{},lang:'en'},getElementById:()=>null,querySelector:()=>null,createElement:()=>({dataset:{}}),head:{appendChild:tag=>styles.push(tag)}};const jsx=(type,props,key)=>({type,props,key});const react={memo:fn=>fn,useMemo:fn=>fn(),useEffect:()=>{},useState:initial=>[typeof initial==='function'?initial():initial,()=>{}]};vm.runInNewContext(code,{window:{__ModuleLoader__:{load:x=>row=x}},document,console});const plugin=row.factory(name=>{if(name==='zod')return sharedVendors.zod;if(name==='react')return react;if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};if(name==='@xharness/dsh-client-ui-primitives')return new Proxy({},{get:(_t,key)=>key});if(name==='@xharness/dsh-client-runtime/client')return path;throw Error(name)});const ctx={get:()=>({hostDescription:{getSnapshot:()=>({home:'/home/u'})}}),slots:{inject:(_n,fn)=>fn(),register:(spec,component)=>slots.push({spec,component})},plugin:p=>{plugins.push(p.name);p.apply(ctx)}};return{plugin,styles,slots,plugins,ctx}}
const a=harness(frozen.replace('return module.exports;',`Object.assign(exports,{${names.join(',')}});return module.exports;`)),b=harness(compiled.get(id+'/test').bytes.toString());const apis=[a,b];const settled=(patch={})=>({kind:'tool-result',seq:8,time:100,callId:'c',call:{name:'bash',argsRaw:'{"command":"echo hi"}'},callTime:20,content:[{type:'text',text:'hi'}],isError:false,subCalls:[],callView:null,resultView:null,...patch});const running=(patch={})=>({callId:'c',name:'bash',argsRaw:'{"command":"echo hi"}',turn:1,step:1,time:20,callView:null,subCalls:[],...patch});const safe=(fn,...args)=>{try{return json(fn(...args)??null)}catch(e){return{failure:e.message}}};
test('Tool: strict production ABI, inject, all CSS/classmap lifecycle and registered slots unchanged',()=>{const old=harness(frozen),source=harness(compiled.get(id).bytes.toString());assert.deepEqual(Object.keys(source.plugin).sort(),Object.keys(old.plugin).sort());assert.deepEqual(json(source.plugin.inject),json(old.plugin.inject));for(const x of[old,source])x.plugin.apply(x.ctx);assert.deepEqual(json(stripReviewedJobStyle(source.styles)),json(old.styles));assert.deepEqual(source.plugins,old.plugins);assert.deepEqual(json(source.slots.map(x=>x.spec)),json(old.slots.map(x=>x.spec)))})
test('Tool: row variants, stream prefixes, filesystem summary, nonzero exit and interruption are frozen-compatible',()=>{const tools=['bash','pwsh','read','write','edit','grep','glob','web_fetch','web_search','run_code','cordis_run','unknown'];const blocks=[running(),running({argsRaw:'{"command":'}),running({argsRaw:'plain'}),settled(),settled({isError:true,error:{code:'denied',name:'ToolError'}}),settled({isError:true,error:{code:'interrupted',name:'Cancelled'}}),settled({content:[]}),settled({content:[{type:'text',text:'a'},{type:'image',mediaType:'image/png',data:'secret pixels'}]})];for(const name of tools){assert.equal(b.plugin.classifyTool(name),a.plugin.classifyTool(name));for(const block of blocks)assert.deepEqual(safe(b.plugin.toolRowModel,name,block,'/home/u/work','/home/u'),safe(a.plugin.toolRowModel,name,block,'/home/u/work','/home/u'))}})

test('Tool: exact browser MCP calls identify embedded/background without changing dispatch or run state',()=>{
 const model=(plugin,server,overrides={})=>b.plugin.toolRowModel('plugin_mcp',running({argsRaw:JSON.stringify({action:'call',plugin,server,tool:'browser',arguments:{action:'navigate',url:'https://private.invalid/?token=not-a-real-token'},...overrides})}))
 assert.equal(model('browser-use','browser').title,'Background browser')
 assert.equal(model('@xharness/native-browser','webview').title,'Embedded browser')
 assert.equal(model('browser-use','browser').summary,'navigate')
 assert.equal(model('browser-use','browser').state,'running')
 for(const value of [model('other','browser'),model('browser-use','other'),model('browser-use','browser',{action:'describe'})])assert.equal(value.title,'Tool call')
 assert.equal(b.plugin.toolRowModel('plugin_mcp',running({argsRaw:'{"action":"call"'})).title,'Tool call')
 assert.equal(model('browser-use','browser',{arguments:{action:'javascript:secret'}}).summary,'browser')
})
test('Tool: read/diff/search/web intent projection and malformed/unknown fallback differential corpus',()=>{const views=[null,{card:'unknown'},{card:'read',path:'/home/u/work/a.ts',lines:[{number:1,text:'const a=1'}],totalLines:1,lang:'ts'},{card:'diff',diffs:[{path:'a.ts',oldText:'old',newText:'new'}]},{card:'search',shape:'paths',paths:['a','b'],total:5,truncated:true},{card:'search',shape:'paths',paths:[null],total:1,truncated:false},{card:'search',shape:'matches',files:[{path:'a',matches:[{lineNumber:1,line:'yes'}]}],total:1,truncated:false},{card:'search',shape:'matches',files:[null],total:1,truncated:false},{card:'web',kind:'search',sources:[{url:'https://example.test',title:'example'}],truncated:false,answer:'answer'},{card:'web',kind:'fetch',url:'https://example.test',statusCode:200,truncated:true},{card:'web',kind:'unknown'}];for(const view of views)for(const name of['readCardModel','diffCardModel','searchCardModel','webCardModel'])assert.deepEqual(safe(b.plugin[name],settled({resultView:view}),'/home/u/work','/home/u'),safe(a.plugin[name],settled({resultView:view}),'/home/u/work','/home/u'));for(const name of['readCardModel','diffCardModel','searchCardModel','webCardModel'])assert.equal(b.plugin[name](running()),null)})
test('Tool: terminal cwd normalization, running/final status and label forwarding are not simplified',()=>{for(const cwd of[undefined,'/workspace/app','C:\\workspace\\app','\\\\server\\share\\app'])for(const viewCwd of[undefined,'..','/tmp','C:\\tmp'])for(const exitCode of[0,1,undefined]){const block=settled({callView:{card:'terminal',command:'echo hello',cwd:viewCwd},resultView:{card:'terminal',output:'done',exitCode,signal:exitCode===1?'SIGTERM':undefined}});assert.deepEqual(safe(b.plugin.terminalCardModel,block,cwd),safe(a.plugin.terminalCardModel,block,cwd))}assert.deepEqual(json(b.plugin.terminalBlockLabels(x=>x)),json(a.plugin.terminalBlockLabels(x=>x)));for(const card of[{running:true,exitCode:1},{running:false,exitCode:0},{running:false,exitCode:2},{signal:'KILL'}])assert.equal(b.plugin.terminalFailed({card}),a.plugin.terminalFailed({card}))})
test('Tool: recursive subcall keyed dispatch retains selection and fallback routing',()=>{const node={data:{root:running({subCalls:[settled({callId:'child'})]})}};const receipts=apis.map(({plugin})=>json(plugin.ToolCallTree({node,selectedCallId:'child',cwd:'/w',openFile(){},inspectCall(){},t:x=>x,useHostDescription:fn=>fn({home:'/home/u'}),renderSlot:()=>null})));assert.deepEqual(receipts[1],receipts[0])})
test('Tool: collapsed/live row model and selected details body match the old component tree',()=>{for(const block of[running(),settled(),settled({isError:true,error:{code:'interrupted',name:'Cancelled'}})]){const receipts=apis.map(({plugin})=>{const props={toolName:'bash',block,cwd:'/w',home:'/u',openFile(){},inspect(){},t:x=>x};const card=plugin.GenericToolCard(props);return json({card,details:plugin.ToolDetails({block,cwd:'/w',t:x=>x,useHostDescription:fn=>fn({home:'/u'})})})});assert.deepEqual(receipts[1],receipts[0])}})

test('Agent communication: stream, direct and current Host envelope acknowledgements are explicit',()=>{
 const argsRaw=JSON.stringify({action:'send',agent_id:'child-1',message:'Please answer\nUse the local fixture'})
 const model=patch=>json(b.plugin.agentCommunicationModel('agent',settled({call:{name:'agent',argsRaw},...patch})))
 const ack={ok:true,agent_id:'child-1',message_id:'stable-message-1',status:'accepted'}
 const content=value=>[{type:'text',text:JSON.stringify(value)}]
 assert.equal(b.plugin.agentCommunicationModel('agent',running({name:'agent',argsRaw})).phase,'sending')
 for(const value of [ack,{ok:true,content:JSON.stringify(ack),error:'',truncated:false}]){
  const m=model({content:content(value)})
  assert.equal(m.phase,'queued');assert.equal(m.target,'child-1');assert.equal(m.messageId,'stable-message-1')
  for(const chinese of [true,false]){
   const copy=b.plugin.agentCommunicationCopy(m,chinese)
   assert.ok(copy.summary.includes('child-1'));assert.ok(copy.summary.includes('Please answer'))
   assert.ok(copy.body.includes('Please answer\nUse the local fixture'));assert.ok(copy.body.includes('stable-message-1'))
   assert.equal(copy.status,chinese?'已入队':'Queued')
  }
  const card=b.plugin.GenericToolCard({toolName:'agent',block:settled({call:{name:'agent',argsRaw},content:content(value)}),t:x=>x,openFile(){}})
  assert.equal(card.props.title,'Message to agent');assert.equal(card.props.summarySuffix,'Queued')
 }
 assert.equal(b.plugin.agentCommunicationModel('bash',running({argsRaw})),null)
 assert.equal(b.plugin.agentCommunicationModel('agent',running({argsRaw:'{"action":'})),null)
 assert.equal(b.plugin.agentCommunicationModel('agent',running({argsRaw:'{"action":"inspect"}'})),null)
})
test('Agent communication: malformed, mismatched, missing and failed receipts never imply delivery',()=>{
 const argsRaw=JSON.stringify({action:'send',agent_id:'child-1',message:'next task'})
 const ack={ok:true,agent_id:'child-1',message_id:'stable',status:'accepted'}
 const model=(value,patch={})=>b.plugin.agentCommunicationModel('agent',settled({call:{name:'agent',argsRaw},content:[{type:'text',text:JSON.stringify(value)}],...patch}))
 for(const value of [null,[],{},'Both agents are running', {...ack,ok:false},{...ack,ok:'true'}, {...ack,agent_id:'other'}, {...ack,message_id:''},{...ack,status:'running'},{...ack,truncated:true},{...ack,truncated:'false'},{...ack,truncated:null}, {ok:true,content:JSON.stringify(ack),truncated:true},{ok:false,content:JSON.stringify(ack)},{ok:true,content:'malformed'}, {ok:true,content:JSON.stringify({...ack,ok:false})}]){
  assert.equal(model(value).phase,'unconfirmed',JSON.stringify(value))
  assert.equal(model(value).messageId,null)
 }
 for(const code of ['OUTCOME_UNKNOWN','interrupted']){
  assert.equal(model(ack,{isError:true,error:{code,name:'Interrupted'}}).phase,'unknown')
  assert.equal(model(ack,{isError:true,error:{code,name:'Interrupted'}}).state,'stopped')
 }
 assert.equal(model(ack,{isError:true,error:{code:'denied',name:'Error'}}).phase,'failed')
 const copy=b.plugin.agentCommunicationCopy(model(ack,{isError:true}),false)
 assert.ok(copy.body.includes('does not prove the message was not sent'))
})
test('Agent communication: start and stop receipt semantics are not execution or completion',()=>{
 const make=(args,ack)=>b.plugin.agentCommunicationModel('agent',settled({call:{name:'agent',argsRaw:JSON.stringify(args)},content:[{type:'text',text:JSON.stringify(ack)}]}))
 const start=make({action:'start',task:'inspect repository',label:'Review'},{ok:true,agent_id:'child-created',message_id:'child-created:initial',status:'accepted'})
 assert.equal(start.target,'child-created');assert.equal(start.phase,'queued')
 const stop=make({action:'stop',agent_id:'child-created'},{ok:true,agent_id:'child-created',accepted:true})
 assert.equal(stop.phase,'stop-requested');assert.equal(stop.messageId,null)
 assert.equal(make({action:'stop',agent_id:'child-created'},{ok:true,agent_id:'other',accepted:true}).phase,'unconfirmed')
 assert.ok(b.plugin.agentCommunicationCopy(stop,false).body.includes('not proof the agent has stopped'))
})
test('Agent correction: validates both source and checkpoint before showing a managed branch receipt',()=>{
 const args={action:'revert',agent_id:'source',checkpoint_seq:26,message:'correct the direction'}
 const ack={ok:true,agent_id:'branch',source_agent_id:'source',checkpoint_seq:26,message_id:'branch:initial',status:'accepted',filesystem_rollback:false}
 const make=value=>b.plugin.agentCommunicationModel('agent',settled({call:{name:'agent',argsRaw:JSON.stringify(args)},content:[{type:'text',text:JSON.stringify(value)}]}))
 const model=make(ack)
 assert.equal(model.phase,'queued');assert.equal(model.target,'branch');assert.equal(model.source,'source');assert.equal(model.checkpoint,26)
 assert.ok(b.plugin.agentCommunicationCopy(model,false).body.includes('files are not rolled back'))
 for(const invalid of [{...ack,source_agent_id:'other'},{...ack,checkpoint_seq:27},{...ack,filesystem_rollback:true},{...ack,agent_id:'source'}]) assert.equal(make(invalid).phase,'unconfirmed')
})

const processReceipt = (patch = {}) => ({kind:'foreground',stdout:'',stderr:'',exit_code:1,signal:null,success:false,...patch})
const processEnvelope = receipt => ({ok:false,error:`shell command exited with code ${receipt.exit_code}`,truncated:false,content:JSON.stringify(receipt)})
const shellResult = (receipt, patch = {}) => settled({
 isError:true, meta:receipt,
 content:[{type:'text',text:JSON.stringify(processEnvelope(receipt))}], ...patch,
})

test('Shell errors: current metadata, wrapped and legacy direct receipts show diagnostics without changing raw evidence',()=>{
 const receipt=processReceipt({exit_code:101,stdout:'Compiling fixture\n\u001b[31merror[E0599]: no method named fixture\u001b[0m\n  --> src/main.rs:7:1\n'})
 const raw=JSON.stringify(processEnvelope(receipt))
 for(const toolName of ['bash','pwsh']) for(const block of [
  shellResult(receipt),
  shellResult(receipt,{meta:undefined}),
  shellResult(receipt,{meta:undefined,content:[{type:'text',text:JSON.stringify(receipt)}]}),
  shellResult(receipt,{resultView:{card:'terminal',exitCode:101,output:receipt.stdout}}),
 ]){
  const model=b.plugin.toolRowModel(toolName,block)
  assert.equal(model.state,'error')
  assert.equal(model.errorSummary,'Exit 101 · error[E0599]: no method named fixture')
  assert.equal(model.output,b.plugin.resultText(block),'expanded/raw output must remain exact')
 }
 assert.equal(b.plugin.resultText(shellResult(receipt)),raw)
})

test('Shell errors: no-match exit one remains non-success and never invents a build failure',()=>{
 for(const stdout of ['', 'manual pem\n', 'parse added\n']){
  const block=shellResult(processReceipt({stdout}))
  const before=JSON.stringify(block)
  const model=b.plugin.toolRowModel('bash',block)
  assert.equal(model.errorSummary,'Exit 1')
  assert.equal(model.state,'error')
  assert.equal(JSON.stringify(block),before,'presentation must not mutate evidence or status')
 }
 const successful=settled({meta:processReceipt({exit_code:0,success:true}),content:[{type:'text',text:'Build complete'}]})
 assert.equal(b.plugin.toolRowModel('bash',successful).state,'ok')
 assert.equal(b.plugin.toolRowModel('bash',successful).errorSummary,null)
})

test('Shell errors: interrupted, permission, unknown tools and malformed records retain their contracts',()=>{
 const receipt=processReceipt({stderr:'permission denied\n'})
 const stopped=shellResult(receipt,{error:{name:'Cancelled',code:'interrupted'}})
 assert.equal(b.plugin.toolRowModel('bash',stopped).state,'stopped')
 assert.equal(b.plugin.toolRowModel('bash',stopped).errorSummary,null)
 const denied=settled({isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:'Approval required',truncated:false,content:''})}]})
 assert.equal(b.plugin.toolRowModel('bash',denied).errorSummary,'Approval required')
 for(const name of ['read','agent','unknown']){
  const block=shellResult(receipt)
  assert.equal(b.plugin.toolRowModel(name,block).errorSummary,JSON.stringify(processEnvelope(receipt)))
 }
 for(const meta of [null,[],{}, {...receipt,exit_code:'1'}, {...receipt,stdout:3}, {...receipt,kind:'background'}]){
  const block=settled({isError:true,meta,content:[{type:'text',text:'original failure'}]})
  assert.equal(b.plugin.toolRowModel('bash',block).errorSummary,'original failure')
 }
 const signal=shellResult(processReceipt({exit_code:null,signal:9,stderr:'terminated\n'}))
 assert.equal(b.plugin.toolRowModel('bash',signal).errorSummary,'Signal 9 · terminated')
 const timed=shellResult(processReceipt({termination:'timedout',exit_code:null,signal:9}))
 assert.equal(b.plugin.toolRowModel('bash',timed).errorSummary,'Timed out')
 const cancelled=shellResult(processReceipt({termination:'cancelled',exit_code:null}))
 assert.equal(b.plugin.toolRowModel('bash',cancelled).errorSummary,'Cancelled')
})

test('Shell errors: bounded preview, empty output and legacy terminal status never hide full diagnostics',()=>{
 const output='warning\n'+'x'.repeat(400000)+'\nerror[E0063]: missing field\n'
 const view={card:'terminal',output,exitCode:101}
 const block=settled({resultView:view,isError:true,content:[{type:'text',text:output}]})
 assert.equal(b.plugin.toolRowModel('bash',block).errorSummary,'Exit 101 · error[E0063]: missing field')
 assert.equal(b.plugin.terminalCardModel(block).card.output,output)
 const legacy=settled({resultView:{card:'terminal',output:'error: build stopped',exitCode:101}})
 assert.equal(b.plugin.toolRowModel('bash',legacy).errorSummary,'Exit 101 · error: build stopped')
 assert.equal(b.plugin.GenericToolCard({toolName:'bash',block:legacy,t:x=>x,openFile(){}}).props.state,'error')
 const empty=shellResult(processReceipt(),{content:[]})
 assert.equal(b.plugin.toolRowModel('bash',empty).errorSummary,'Exit 1')
 const long=shellResult(processReceipt({stderr:'error: '+'e'.repeat(10000)}))
 assert.ok(b.plugin.toolRowModel('bash',long).errorSummary.length<=252)
})
