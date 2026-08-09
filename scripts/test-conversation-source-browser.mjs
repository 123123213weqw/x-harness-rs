import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { compile, legacyTest } from './conversation-test-harness.mjs'
const deps=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-types-step1/browser-deps',require=createRequire(resolve(deps,'package.json'));
const {chromium,webkit}=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium',impl=process.env.UI_TEST_IMPL??'source';
const source=impl==='legacy'?legacyTest:compile().test;
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<html><head></head><body style="margin:0"><div id="root" style="height:740px;width:1000px"></div></body></html>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await({chromium,webkit}[engine]).launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1000,height:780}});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 for(const file of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(deps,'node_modules',file)});
 await page.addStyleTag({content:':root{--dsh-composer-side-clearance:0px;--dsh-chat-content-width:760px;--dsh-composer-card-max-width:800px;--dsh-composer-text-max-height:240px;--dsh-composer-dock-inset:4px;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-label-caption:#999;--dsw-alias-bg-base:#fff;--dsw-specific-input-major:#fafafa;--dsw-alias-border-l2:#ddd;--dsw-alias-border-l3:#bbb;--dsw-alias-markdown-code-block:#f4f4f4;--ds-font-family-code:monospace;--dsw-alias-state-business-primary:#4577e5;}body{font:14px sans-serif}button{font:inherit}'});
 await page.addScriptTag({content:'window.__ModuleLoader__={load:r=>window.registration=r}'});await page.addScriptTag({content:source});
 await page.evaluate(()=>{
  const jsx=(type,props,key)=>React.createElement(type,key===undefined?props:{...props,key});
  const makeStore=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;listeners.forEach(fn=>fn())},update:fn=>{value={...value};fn(value);listeners.forEach(fn=>fn())}}};
  window.makeStore=makeStore;const hook=store=>selector=>selector(React.useSyncExternalStore(store.subscribe,store.getSnapshot));
  const Button=({variant,size,...props})=>jsx('button',props),Tooltip=({children})=>children;
  const Menu=({open,items,anchor,onSelect})=>jsx(React.Fragment,{children:[anchor,open&&jsx('div',{role:'menu',style:{position:'absolute',bottom:40,background:'#fff',padding:8,zIndex:50,border:'1px solid #aaa'},children:items.map(item=>item.type==='separator'?jsx('hr',{key:item.id}):jsx('button',{key:item.id,role:'menuitem',disabled:item.disabled,onClick:()=>onSelect(item.id),children:[item.icon,item.label]}))})]});
  const Modal=props=>props.open?jsx('div',{role:'dialog','aria-label':props.title,children:[jsx('button',{'aria-label':props.closeLabel,onClick:props.onClose,children:props.closeLabel}),props.children,props.footer]}):null;
  const DisclosureRow=({title,open,onToggle,collapsedContent,children})=>jsx('div',{children:[jsx('button',{onClick:onToggle,'aria-expanded':open,children:[title,!open&&collapsedContent]}),open&&children]});
  const RiskConfirmation=props=>props.open?jsx('div',{role:'dialog','aria-label':props.title,children:[jsx('input',{type:'checkbox','aria-label':props.acknowledgeLabel,checked:props.acknowledged,onChange:event=>props.onAcknowledgedChange(event.target.checked)}),jsx('button',{disabled:props.disabled||!props.acknowledged,onClick:props.onConfirm,children:props.confirmLabel}),jsx('button',{onClick:props.onCancel,children:props.cancelLabel})]}):null;
  const primitives=new Proxy({Button,Tooltip,Menu,Modal,DisclosureRow,RiskConfirmation,MarkdownText:({text})=>jsx('div',{'data-markdown':'',children:text}),MessageText:({text})=>jsx('div',{children:text}),JsonBlock:({label,payload})=>jsx('pre',{children:label+JSON.stringify(payload)}),StateDot:()=>jsx('span',{}),writeClipboard:async text=>{window.copied=text;return true},Toast:({text})=>jsx('div',{role:'alert',children:text})},{get:(o,k)=>o[k]??(()=>jsx('svg',{width:14,height:14}))});
  const runtime={publishChatSnapshot:value=>value,createSnapshotStore:makeStore,defineStore:spec=>({spec}),workspaceTitleOf:cwd=>cwd.split('/').filter(Boolean).at(-1)||'',sessionRecallLabels:s=>s?.labels??[],isAppendSurfaceEvent:e=>e.type==='user/message'&&e.surfaceOp?.op!=='replace',isReplacementSurfaceEvent:e=>e.surfaceOp?.op==='replace',shallowEqual:(a,b)=>a===b,resolveWorkspacePath:(cwd,p)=>p.startsWith('/')?p:cwd+'/'+p,displayFailureMessage:e=>e.message};
  window.plugin=registration.factory(name=>name==='react'?React:name==='react-dom'?ReactDOM:name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:React.Fragment}:name==='@xharness/dsh-client-ui-primitives'?primitives:name==='@xharness/cordis'?{Service:class{constructor(ctx){this.ctx=ctx}},Context:{is:ctx=>ctx!==null&&typeof ctx==='object'}}:name==='@xharness/dsh-client-ui-slots'?{resolveSlotLabel:x=>x}:runtime);
  window.root=ReactDOM.createRoot(document.getElementById('root'));window.renderComponent=(name,props)=>ReactDOM.flushSync(()=>root.render(jsx(plugin[name],props)));
  window.t=(key,args)=>{let value=plugin.en[key]??key;for(const[k,v]of Object.entries(args??{}))value=value.replaceAll('{'+k+'}',String(v));return value};
  window.setMode=name=>{window.mode=name;ReactDOM.flushSync(()=>root.render(jsx(App,{})))};
  window.calls=[];window.failSend=false;window.readReady=false;window.sendWait=null;
  const ctx={effect:fn=>fn()};window.conversation=new plugin.ConversationController(ctx,{input:{},blocks:{}});
  window.session={prompt:async(content,mode,signal,policy)=>{calls.push({content,mode,policy});if(sendWait)await sendWait;return failSend?{ok:false,error:{message:'rejected'}}:{ok:true,value:{}}}};
  window.shell=new plugin.SessionInputShell({actx:{},defaultSink:(text,ids,mode,signal)=>conversation.sendSession(session,text,ids,mode,signal,!!shell.xhEditor?.state.editing),commandImages:{serialize:ids=>conversation.serializeDraftImages(ids),release:ids=>ids.forEach(id=>conversation.releaseDraftImage(id)),unsupportedNotice:()=> 'no command images'}});
  const storage=plugin.xhEditStorage();window.storage=storage;
  window.editor=new plugin.XHarnessMessageEditor({id:'browser-s',shell,conversation,storage,t,running:()=>snapshot.getSnapshot().running,focus:()=>document.querySelector('textarea')?.focus(),read:async()=>readReady?{ok:true,value:{attachment:{attachmentId:'a',mediaType:'text/plain',bytes:2},data:new Uint8Array([65,66])}}:{ok:false,error:{message:'missing source'}}});shell.xhEditor=editor;
  const snapshot=makeStore({openState:'open',composerPhase:'active',running:false,removed:false,promptError:null,subagent:null,queue:[],pending:[],hasMore:false,loadingOlder:false,chat:{order:[],nodes:new Map(),timeline:{turns:[],steps:[]},legacy:{nodes:[]}}});window.snapshot=snapshot;
  const summaries=makeStore({byId:{s:{cwd:'/repo',blank:false,running:false}}}),workspaces=makeStore({items:[{workspaceId:'w',title:'repo',sessionIds:['s']}],phase:'ready'}),chatStore=makeStore({selection:null});
  window.pressure={pressureTokens:250,contextWindow:1000,composition:{systemTokens:10,userTokens:20,assistantTokens:20,toolResultTokens:15,toolDefinitionTokens:10,mcpToolDefinitionTokens:15,protocolTokens:10}};
  const projections=makeStore({});window.projections=projections;window.setPressure=p=>{pressure=p;projections.set({...projections.getSnapshot()})};
  const useProjection=(key,selector)=>{React.useSyncExternalStore(projections.subscribe,projections.getSnapshot);const value=key==='contextPressure'?pressure:undefined;return selector?selector(value):value};
  const notices=hook(shell.notices),useInput=hook(shell.state),useSession=hook(snapshot),useSessions=hook(summaries),useWorkspaces=hook(workspaces),useStore=hook(chatStore);
  const nodeProps={t,editMessage:content=>editor.request(content),forkMessage:async(seq,content)=>calls.push({fork:true,seq,content}),editAvailable:true,renderMessageImages:owner=>jsx('div',{'data-message-attachments':'',children:owner.images.map(x=>x.attachment.name).join(',')}),fileMentions:()=>undefined,useTurnData:()=>undefined,openFile:async()=>{},forkAt:async()=>{},inspectCall:()=>{}};
  const barProps={sessionId:'s',useSession,useInput,inputActions:shell.actions,keyboard:shell,draftImages:ids=>conversation.draftImages(ids),addImages:files=>{try{const images=conversation.createDraftImages(files);shell.addImages(images.map(x=>x.id));return null}catch(e){return e.message}},removeImage:id=>{shell.removeImage(id);if(!shell.snapshot.imageIds.includes(id))conversation.releaseDraftImage(id)},resolveSubmitMode:()=> 'queue',toggleCommandMenu:()=>calls.push({commands:true}),stop:()=>{},command:async()=>false,useNotices:notices,useLexicon:hook(shell.lexicon),useMenuLauncher:()=>false,useProjection,t,renderSlot:(key,owner)=>key==='conversation.input.attachments'?jsx('div',{'data-attachment-rail':'',children:owner.attachments.map(x=>jsx('button',{key:x.id,'aria-label':'Remove '+x.file.name,onClick:()=>owner.onRemoveImage(x.id),children:x.file.name}))}):null};
  const chatProps={sessionId:'s',useSession,useSessions,useStore,loadOlder:()=>calls.push({older:true}),loadImage:async()=>'',chatScroll:{read:()=>null,save:p=>window.savedScroll=p},...nodeProps,renderSlot:(key,owner)=>key==='conversation.chat.node'?jsx(({user:plugin.UserMessageNodeView,steering:plugin.UserMessageNodeView,'assistant-step':plugin.AssistantNodeView,compaction:plugin.CompactionNodeView,'run-checkpoint':plugin.XhCheckpointView})[owner.node.kind]??(()=>null),{...nodeProps,...owner}):null};
  window.installNodes=(count=8)=>{const nodes=new Map(),order=[];for(let i=0;i<count;i++){const key='u'+i;order.push(key);nodes.set(key,{key,kind:'user',data:{kind:'user',seq:i,time:Date.now(),source:{kind:'user'},content:[{type:'text',text:'History '+i+' '+ 'body '.repeat(15)}]},location:{kind:'session'}})}
   const assistant={key:'assistant',kind:'assistant-step',data:{status:'settled',turn:0,step:0,time:Date.now(),blocks:[{kind:'reasoning',text:'first line\nreasoning details'},{kind:'text',text:'final answer'}]},location:{kind:'session'}};order.push(assistant.key);nodes.set(assistant.key,assistant);
   const comp={key:'compact',kind:'compaction',data:{kind:'compaction',seq:count+1,time:Date.now(),summary:'saved summary',summaryEventSeq:count+1,shadowedItemCount:3,shadowedTokenCount:200},location:{kind:'session'}};order.push(comp.key);nodes.set(comp.key,comp);
   const checkpoint={key:'checkpoint',kind:'run-checkpoint',data:{kind:'run-checkpoint',seq:count+2,time:Date.now(),turn:0,step:0,noticeKind:'limit',message:'saved checkpoint'},location:{kind:'session'}};order.push(checkpoint.key);nodes.set(checkpoint.key,checkpoint);
   snapshot.set({...snapshot.getSnapshot(),chat:{...snapshot.getSnapshot().chat,order,nodes}})};
  function App(){
   if(mode==='permissions')return jsx(plugin.PermissionSelect,{value:window.permissionValue,locked:false,command:async line=>{calls.push({permission:line});if(window.permissionWait)await permissionWait;return true},t});
   if(mode==='meter')return jsx(plugin.ContextMeter,{useProjection,t});
   if(mode==='bar')return jsx(plugin.XHarnessEditableInputBar,barProps);
   if(mode==='window'){return jsx('div',{'data-conversation-scroll':'',style:{height:400,overflowY:'auto',width:700},children:Array.from({length:150},(_,i)=>jsx(plugin.XhTranscriptWindowRow,{key:i,'data-row':i,keepMounted:i===149,children:jsx(Counter,{index:i})}))})}
   if(mode==='queue')return jsx(plugin.QueueDock,{useSession,t,updateQueue:async(id,action)=>{calls.push({queue:id,action});if(window.queueFail)throw Error('queue race')},notify:(_level,text)=>calls.push({notice:text})});
   if(mode==='approval')return jsx(plugin.ApprovalPanel,{matched:window.approval,useSession,t});
   return jsx(plugin.ConversationRoot,{sessionId:'s',useSession,useSessions,useWorkspaces,useInput,useComposerBlock:()=>undefined,t,selectWorkspace:async()=>{},renderSlotChain:(_k,_o,options)=>options.fallback,renderSlot:(key,owner)=>key==='conversation.session'?jsx(plugin.ChatView,chatProps):key==='conversation.composer.bar'?jsx(plugin.XHarnessEditableInputBar,{...barProps,...owner}):null});
  }
  function Counter({index}){const[clicked,set]=globalThis.__xhTranscriptState.get(React.createElement).useState('fixture-counter',false);return jsx('button',{'data-counter':index,style:{height:80,width:'100%'},onClick:()=>set(true),children:'row '+index+' count '+(clicked?1:0)})}
  window.mode='bar';setMode('bar');
 });
 // Real palettes + monochrome override: both Send and Stop must use the
 // matching foreground, not a white glyph on the dark theme's white fill.
 if (impl === 'source') {
  const palette = await page.addStyleTag({content:readFileSync('ui/src/modules/theme/design-platform.css','utf8')+'\n'+readFileSync('ui/overrides/monochrome.css','utf8')})
  await page.evaluate(()=>{shell.setDraft('Contrast probe');setMode('bar')})
  for (const dark of [false,true]) {
   await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark)
   for (const running of [false,true]) {
    await page.evaluate(running=>snapshot.set({...snapshot.getSnapshot(),running}),running)
    const action=page.getByRole('button',{name:running?'Stop generating':'Send message',exact:true})
    await page.waitForFunction(label=>document.querySelector(`[aria-label="${label}"]`)?.disabled===false,running?'Stop generating':'Send message')
    // Theme changes animate the background for 100 ms; measure settled
    // contrast, not the old fill paired with the new foreground.
    await page.waitForFunction(({label,bg})=>{const el=document.querySelector(`[aria-label="${label}"]`);return el&&getComputedStyle(el).backgroundColor===bg},{label:running?'Stop generating':'Send message',bg:dark?'rgb(245, 245, 245)':'rgb(23, 23, 23)'})
    const contrast=await action.evaluate(el=>{
     const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number)
     const luminance=rgb=>rgb.map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0)
     const style=getComputedStyle(el),fg=luminance(rgb(style.color)),bg=luminance(rgb(style.backgroundColor))
     return {color:style.color,background:style.backgroundColor,foreground:style.getPropertyValue('--dsw-alias-label-primary-foreground'),ratio:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05),disabled:el.disabled,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}
    })
    assert.equal(contrast.disabled,false)
    assert.ok(contrast.ratio>=4.5,`${dark?'dark':'light'} ${running?'stop':'send'} glyph contrast: ${JSON.stringify(contrast)}`)
    assert.equal(contrast.width,34);assert.equal(contrast.height,34)
   }
  }
  await page.evaluate(()=>{snapshot.set({...snapshot.getSnapshot(),running:false});shell.setDraft('')})
  await page.waitForFunction(()=>document.querySelector('[aria-label="Send message"]')?.disabled)
  assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true,'empty drafts stay disabled')
  await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));await palette.evaluate(el=>el.remove())
 }
 // Native picker, shared plus-menu focus, commands and draft submission.
 await page.getByRole('button',{name:'Add attachments or commands',exact:true}).press('ArrowDown');await page.getByRole('menuitem',{name:'Add images or files'}).waitFor();await page.waitForFunction(()=>document.activeElement?.textContent?.includes('Add images or files'));assert.equal(await page.getByRole('menuitem',{name:'Add images or files'}).evaluate(e=>e===document.activeElement),true);
 await page.getByRole('menuitem',{name:'Add images or files'}).press('End');assert.equal(await page.getByRole('menuitem',{name:'Commands'}).evaluate(e=>e===document.activeElement),true);await page.getByRole('menuitem',{name:'Commands'}).press('Escape');assert.equal(await page.getByRole('button',{name:'Add attachments or commands',exact:true}).evaluate(e=>e===document.activeElement),true);
 await page.getByRole('button',{name:'Add attachments or commands',exact:true}).click();const chooser=page.waitForEvent('filechooser');await page.getByRole('menuitem',{name:'Add images or files'}).click();await(await chooser).setFiles({name:'report.txt',mimeType:'text/plain',buffer:Buffer.from('file bytes')});await page.getByRole('button',{name:'Remove report.txt'}).waitFor();await page.locator('textarea').fill('hello');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(()=>calls.some(x=>x.content));assert.equal(await page.evaluate(()=>calls.find(x=>x.content).content[0].type),'file');await page.waitForFunction(()=>shell.snapshot.imageIds.length===0&&shell.snapshot.draft==='');
 // Editor replace-confirm, cancel/restore, missing attachment retry and portable IDB File storage.
 await page.locator('textarea').fill('unsent draft');await page.evaluate(()=>editor.request([{type:'text',text:'history edit'}]));await page.getByRole('alertdialog').waitFor();await page.getByRole('button',{name:'Replace draft',exact:true}).click();await page.waitForFunction(()=>editor.state.editing);assert.equal(await page.locator('textarea').inputValue(),'history edit');await page.getByRole('button',{name:'Cancel editing',exact:true}).click();await page.waitForFunction(()=>editor.state.phase==='idle');assert.equal(await page.locator('textarea').inputValue(),'unsent draft');
 await page.locator('textarea').fill('');await page.evaluate(()=>editor.request([{type:'file',attachment:{attachmentId:'a',name:'source.txt',mediaType:'text/plain',bytes:2}}]));await page.getByRole('button',{name:'Retry',exact:true}).waitFor();assert.equal(await page.evaluate(()=>{try{editor.guardSubmit();return false}catch{return true}}),true);await page.evaluate(()=>readReady=true);await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>conversation.draftImages(shell.snapshot.imageIds)[0]?.loadState==='ready');await page.getByRole('button',{name:'Cancel editing',exact:true}).click();await page.waitForFunction(()=>editor.state.phase==='idle');
 const idb=await page.evaluate(async()=>{await storage.save('portable',{version:1,backup:{text:'old',images:[]},draft:{text:'file',images:[{file:new File(['portable bytes'],'web-kit.txt',{type:'text/plain'})}]}});const record=await plugin.xhEditStorage().load('portable');const result={text:record.draft.text,name:record.draft.images[0].file.name,bytes:await record.draft.images[0].file.text()};await storage.remove('portable');return result});assert.deepEqual(idb,{text:'file',name:'web-kit.txt',bytes:'portable bytes'});
 // Context seat is stable when missing/pending, and seven segments match actual reading.
 await page.evaluate(()=>setMode('meter'));assert.equal(await page.locator('svg circle').count(),8);await page.getByRole('button').click();await page.getByRole('dialog').waitFor();assert.match(await page.getByRole('dialog').innerText(),/25%/);await page.keyboard.press('Escape');await page.evaluate(()=>setPressure({phase:'preparing'}));assert.equal(await page.getByRole('button').isDisabled(),true);await page.evaluate(()=>setPressure(undefined));assert.equal(await page.locator('svg').count(),1);
 // Actual resident conversation tree: user editing, reasoning, compaction disclosure, limit notices.
 await page.evaluate(()=>{installNodes();setMode('conversation')});await page.getByText('final answer',{exact:true}).waitFor();await page.getByRole('button',{name:/Think/}).click();await page.getByText('first line\nreasoning details',{exact:true}).waitFor();await page.getByRole('button',{name:/Context compacted/}).click();await page.getByText('saved summary',{exact:true}).waitFor();
 // Linux WebKit appends a layout LF to aggregate details.innerText. Verify
 // the exact producer content in each DOM seat, without trimming either.
 const checkpoint=page.locator('details[open]');assert.equal(await checkpoint.count(),1);
 assert.equal(await checkpoint.locator(':scope > summary').textContent(),'执行已停止：步骤硬上限');
 assert.equal(await checkpoint.locator(':scope > div').textContent(),'saved checkpoint');assert.ok(await page.locator('[data-message-edit]').count()>0);
 // A failed history open is an alert with the same runtime retry action, not a silent dead end.
 await page.evaluate(()=>snapshot.set({...snapshot.getSnapshot(),openState:'error',openError:{message:'history offline',code:'offline'},chat:{...snapshot.getSnapshot().chat,order:[],nodes:new Map()}}));
 await page.getByRole('alert').filter({hasText:'history offline'}).waitFor();await page.locator('[data-history-retry]').click();assert.ok(await page.evaluate(()=>calls.some(x=>x.older)));
 await page.evaluate(()=>snapshot.set({...snapshot.getSnapshot(),openState:'open',openError:null}));
 // Latest master silver hero has no stale preview badge or unregistered runtime selector.
 await page.evaluate(()=>{snapshot.set({...snapshot.getSnapshot(),composerPhase:'blank',chat:{...snapshot.getSnapshot().chat,order:[],nodes:new Map()}});setMode('conversation')});
 assert.equal(await page.locator('[data-xh-silver-glow]').count(),1);assert.equal(await page.locator('[data-xh-silver-input]').count(),1);assert.equal(await page.getByText('Preview',{exact:true}).count(),0);
 // Real strict-session header preserves ancestry across edit-fork and subagent routes.
 await page.evaluate(()=>renderComponent('ConversationSessionHeader',{sessionId:'agent',useSession:select=>select({blank:false,composerPhase:'active'}),useSessions:select=>select({byId:{parent:{id:'parent',displayTitle:'Parent',origin:'user'},fork:{id:'fork',displayTitle:'Fork',origin:'fork',parentId:'parent'},agent:{id:'agent',displayTitle:'Agent',origin:'subagent',parentId:'fork'}}}),useStore:select=>select({view:'chat'}),views:{subscribe:()=>()=>{},version:()=>0,list:()=>[{id:'chat',label:'Chat'}]},actions:{setView:()=>{}},renderSlot:()=>null,open:id=>calls.push({open:id}),t}));
 const crumbs=page.getByRole('navigation');assert.deepEqual(await crumbs.getByRole('button').allTextContents(),['Parent','Fork','Agent']);assert.equal(await crumbs.getByRole('button',{name:'Agent',exact:true}).isDisabled(),true);await crumbs.getByRole('button',{name:'Parent',exact:true}).click();assert.ok(await page.evaluate(()=>calls.some(call=>call.open==='parent')));
 // Permission selection explains current versus next round, with acknowledgement before full access.
 await page.evaluate(()=>{permissionValue={currentValue:'workspace-write',activeValue:'read-only',pending:true,options:[{value:'read-only',name:'read-only'},{value:'workspace-write',name:'workspace-write'},{value:'danger-full-access',name:'full-access'},{value:'custom',name:'custom'}]};setMode('permissions')});
 assert.match(await page.getByRole('button').innerText(),/下一轮生效/);assert.match(await page.getByRole('button').getAttribute('title'),/当前轮：read-only/);await page.getByRole('button').click();assert.equal(await page.getByRole('menuitem').count(),3);await page.getByRole('menuitem',{name:'Full access',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('dialog').getByRole('button').first().isDisabled(),true);await page.getByRole('checkbox').check();await page.getByRole('dialog').getByRole('button').first().click();await page.waitForFunction(()=>calls.some(x=>x.permission==='/permission danger-full-access'));
 // Approval takeover receipts re-arm rejected answers and retain a one-shot accepted latch.
 await page.evaluate(()=>{window.answerAccepted=false;window.approval={key:'approval-1',sessionId:'s',payload:{approvalId:'a',toolName:'bash',reason:'Needs approval'},respond:async result=>{calls.push({approval:result});return{accepted:answerAccepted,reason:'retry'}}};setMode('approval')});
 await page.getByRole('button',{name:'Allow once',exact:true}).click();await page.waitForFunction(()=>document.querySelector('button')?.disabled===false);await page.evaluate(()=>answerAccepted=true);await page.getByRole('button',{name:'Allow once',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Allow once',exact:true}).isDisabled(),true);assert.equal(await page.evaluate(()=>calls.filter(x=>x.approval).length),2);
 // Queue edit uses authoritative IDs, sends steering only while running, and reports stale-row failures.
 await page.evaluate(()=>{snapshot.set({...snapshot.getSnapshot(),running:true,queue:[{id:'q',placement:'queued',preview:'queued words',text:'queued words',content:[{type:'text',text:'queued words'}]}]});setMode('queue')});
 await page.getByRole('button',{name:'Edit queued message',exact:true}).click();await page.getByRole('textbox',{name:'Edit queued message',exact:true}).fill('changed queue');await page.getByRole('textbox',{name:'Edit queued message',exact:true}).press('Enter');await page.waitForFunction(()=>calls.some(x=>x.queue));assert.equal(await page.evaluate(()=>calls.find(x=>x.queue).action.kind),'edit');
 await page.getByRole('button',{name:'Steer queued message',exact:true}).click();await page.waitForFunction(()=>calls.some(x=>x.queue&&x.action.kind==='steer'));
 await page.evaluate(()=>{queueFail=true});await page.getByRole('button',{name:'Remove queued message',exact:true}).click();await page.waitForFunction(()=>calls.some(x=>x.notice));
 // Measured DOM eviction retains whole history and interacted-row local state across scroll/reflow.
 await page.evaluate(()=>setMode('window'));await page.locator('[data-counter="0"]').click();assert.equal(await page.locator('[data-counter="0"]').innerText(),'row 0 count 1');
 const scroll=page.locator('[data-conversation-scroll]');await scroll.evaluate(e=>e.scrollTop=e.scrollHeight);await page.waitForFunction(()=>document.querySelectorAll('[data-transcript-mounted="false"]').length>100);assert.equal(await page.locator('[data-row]').count(),150);assert.equal(await page.locator('[data-counter="149"]').count(),1);
 // Latest master intentionally does not pin clicked buttons forever. Exercise
 // the row-owned bridge (as the real Tool/Reasoning/Cordis rows do), rather
 // than depending on browser-specific button focus preserving a React hook.
 // Linux Chromium focuses clicked buttons; macOS/WebKit may not. Focus is
 // intentionally protected until released, independent of click persistence.
 await page.evaluate(()=>document.activeElement?.blur());
 await page.locator('[data-counter="0"]').waitFor({state:'detached'});
 await scroll.evaluate(e=>{e.style.width='500px';e.scrollTop=0});await page.locator('[data-counter="1"]').waitFor();assert.equal(await page.locator('[data-counter="0"]').innerText(),'row 0 count 1');
 await page.evaluate(()=>root.unmount());assert.deepEqual(errors,[]);console.log(`${engine} ${impl}: whole resident conversation + light/dark Send/Stop contrast + composer/menu/file send + editor/IDB + context ring + reasoning/compaction/checkpoint + approval/queue/permissions/silver hero/fork ancestry + transcript pin/evict/reflow passed`);
} finally {await browser.close();await new Promise(r=>server.close(r))}
