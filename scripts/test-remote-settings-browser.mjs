/** Actual owned React view + typed fetch client in isolated browsers.
 * Loopback protocol fixtures only, not native keyring/platform/model acceptance.
 */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {resolve,join} from 'node:path'
import {mkdirSync} from 'node:fs'
import {remoteSettingsModule} from './fixtures/remote-settings-module.mjs'
const deps=process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests'
const require=createRequire(resolve(deps,'package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const {chromium,webkit}=require('playwright')
assert.ok(['chromium','webkit'].includes(engine))
const bot={channel:'telegram',id:'123'}
let account={account:bot,enabled:false,revision:1,credential_reference_saved:true,connection:{state:'disabled'}}
const makeGrant=(n)=>({principal:{id:'p'+n,host:'fixture-host',sender:{channel:'telegram',account:'123',user:String(450+n)},workspaces:['w'],sessions:['s'],revision:1,revoked:false},bindings:[{id:'b'+n,principal:'p'+n,conversation:String(450+n),workspace:'w',session:'s',generation:1}]})
let grants=[1,2,3].map(makeGrant),uncertain=true,offlineWrite=false,conflict=false,notEnabled=false
grants[1].principal.workspaces.push('missing-workspace');grants[1].principal.sessions.push('missing-session')
grants[1].creation_policy={principal:'p2',principal_revision:1,generation:7,workspaces:['missing-workspace']}
const inboxRow=n=>({identity:{key:'remote-v1-'+n.toString(16).padStart(64,'0'),sequence:200+n,principal:'p1',principal_revision:1,binding:{id:'b1',principal:'p1',conversation:'451',workspace:'w',session:'s',generation:1},identity_sha256:'b'.repeat(64)},command:n===1?'automation_control':n===2?'answer_interaction':'cancel',interaction:n===2?'approval':null,observed_accepted_allowed:n!==1,private:'PRIVATE_INPUT_AND_HANDLE'})
let inboxRows=Array.from({length:26},(_,n)=>inboxRow(n+1)),inboxOffline=false
const writes=[],reads=[],requests=[]
const server=createServer(async(req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:14px system-ui;margin:16px;--color-bg-primary:#fff;--color-bg-secondary:#f5f5f5;--color-text-primary:#161616;--color-text-secondary:#555;--color-border:#ddd;--color-bg-control:#eee;--color-bg-hover:#e5e5e5;--dsw-alias-label-primary:var(--color-text-primary);--dsw-alias-border-l2:var(--color-border);--dsw-alias-bg-layer-1:var(--color-bg-secondary);color:var(--color-text-primary);background:var(--color-bg-primary)}</style></head><body><div id="root"></div></body></html>');return}
 assert.equal(req.url,'/api/remote-control/manage');assert.equal(req.method,'POST')
 assert.equal(req.headers['x-xharness-remote-admin'],'v1');assert.equal(req.headers['content-type'],'application/json')
 let text='';for await(const chunk of req)text+=chunk
 const action=JSON.parse(text);requests.push(action.type)
 if(['status','grants','uncertain_replies','uncertain_inbox'].includes(action.type))reads.push(action);else writes.push(action)
 if(notEnabled){res.statusCode=404;res.end('not enabled');return}
 if((inboxOffline&&action.type==='resolve_inbox')||(offlineWrite&&!['status','grants','uncertain_replies','uncertain_inbox'].includes(action.type))){req.socket.destroy();return}
 if(conflict&&action.type==='grant_scopes'){res.statusCode=409;res.end(JSON.stringify({ok:false,error:{code:'conflict'}}));return}
 let value
 switch(action.type){
  case 'status':value={host:'fixture-host',manager:{state:'running'},accounts:[account],credential_cleanup_pending:false};break
  case 'grants':value=action.after?{items:[grants[2]],next:null}:{items:grants.slice(0,2),next:'p2'};break
  case 'uncertain_inbox':{const rows=inboxRows.filter(r=>r.identity.sequence>action.after);value={items:rows.slice(0,25),next:rows.length>25?rows[24].identity.sequence:null};break}
  case 'uncertain_replies':value={items:uncertain?[{key:'uncertain-key',sequence:1,account:bot,sender:grants[0].principal.sender,principal:'p1',binding:grants[0].bindings[0],failure:'provider_uncertain',expected_message:null}]:[],next:null};break
  case 'configure_telegram':
   assert.equal(action.expected_revision,account.revision)
   account={...account,enabled:action.enabled,revision:account.revision+1,connection:{state:action.enabled?'online':'disabled'}}
   value={account:bot,revision:account.revision,credential_cleanup_pending:false};break
  case 'set_enabled':
   assert.equal(action.expected_revision,account.revision)
   account={...account,enabled:action.enabled,revision:account.revision+1,connection:{state:action.enabled?'online':'disabled'}}
   value={account:bot,revision:account.revision,enabled:account.enabled};break
  case 'grant_scopes':{
   let g
   if(action.expected){g=grants.find(g=>g.principal.id===action.expected.principal);assert.equal(g.principal.revision,action.expected.revision);g.principal.revision++;g.bindings[0].generation++}
   else {g=makeGrant(4);grants.push(g)}
   g.principal.sender.user=action.user;g.principal.workspaces=action.workspaces;g.principal.sessions=action.sessions
   assert.equal(action.expected_creation_generation,g.creation_policy?.generation??null)
   g.creation_policy={principal:g.principal.id,principal_revision:g.principal.revision,generation:(action.expected_creation_generation??0)+1,workspaces:action.create_workspaces}
   Object.assign(g.bindings[0],{conversation:action.user,workspace:action.workspace,session:action.session})
   value=g;break
  }
  case 'revoke':grants.find(g=>g.principal.id===action.principal).principal.revoked=true;value={principal:action.principal,revoked:true};break
  case 'resolve_inbox':{
   const row=inboxRows.find(r=>r.identity.key===action.expected.key);assert.deepEqual(action.expected,row.identity);assert.ok(row.observed_accepted_allowed||action.resolution!=='observed_accepted');inboxRows=inboxRows.filter(r=>r!==row)
   value={identity:row.identity,audit:{sequence:1,previous:'uncertain',current:action.resolution==='observed_accepted'?'completed':action.resolution==='verified_not_applied'?'rejected':'abandoned',review:{delivery_key:row.identity.key,actor:'authenticated-desktop',evidence_sha256:action.evidence_sha256,resolution:action.resolution}}};break
  }
  case 'resolve_reply':uncertain=false;value={sequence:1,review:{key:action.key,actor:'authenticated-desktop',evidence_sha256:action.evidence_sha256,resolution:action.resolution},previous:'uncertain',current:action.resolution.type==='observed_delivered'?'delivered':action.resolution.type==='verified_not_sent'?'rejected':'abandoned'};break
  default:throw Error('unexpected action '+action.type)
 }
 res.setHeader('cache-control','no-store');res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,value}))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await ({chromium,webkit}[engine]).launch({headless:true})
const errors=[]
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}})
 page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message))
 await page.goto('http://127.0.0.1:'+server.address().port)
 for(const file of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(deps,'node_modules',file)})
 await page.addScriptTag({content:'window.__ModuleLoader__={load:r=>{window.registration=r}}'})
 await page.addScriptTag({content:remoteSettingsModule()})
 await page.evaluate(()=>{
  window.feature=registration.factory(id=>{
   if(id==='react')return React
   if(id==='react/jsx-runtime')return{jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key}),Fragment:React.Fragment}
   throw Error('unexpected dependency '+id)
  })
  window.root=ReactDOM.createRoot(document.getElementById('root'))
  window.catalogCalls=0
  window.mount=(local=true,locale='en')=>{
   const dictionary=feature[locale]
   const api=feature.createAdminClient()
   const catalog=async()=>{catalogCalls++;return {workspaces:[{id:'w',title:'Fixture workspace',sessions:['s','s2']},{id:'w2',title:'Second workspace',sessions:['t']}],sessions:{s:'Fixture session',s2:'Other fixture session',t:'Second workspace session'}}}
   root.render(React.createElement(feature.RemoteSettings,{key:locale+local,t:key=>dictionary[key]??key,local,api,catalog}))
  }
  mount(false)
 })
 await page.getByText('Manage remote control from local desktop settings.').waitFor()
 assert.equal(requests.length,0,'remote connection must not read native management');assert.equal(await page.evaluate(()=>catalogCalls),0)
 await page.evaluate(()=>mount())
 await page.getByRole('heading',{name:'Remote control & Bot channels'}).waitFor()
 await page.getByRole('textbox',{name:'Numeric Bot ID'}).waitFor()
 await page.getByRole('button',{name:'Load more',exact:true}).click()
 await page.getByText('telegram · 123 / 453',{exact:true}).waitFor()
 const readsBefore=reads.filter(a=>a.type==='grants').length
 await page.waitForTimeout(2700)
 assert.equal(reads.filter(a=>a.type==='grants').length,readsBefore,'background status polling must not silently discard loaded pages')
 await page.getByText('telegram · 123 / 453',{exact:true}).waitFor()
 await page.getByRole('textbox',{name:'Numeric Bot ID'}).fill('123')
 await page.getByLabel('Bot Token (system credential store only)',{exact:true}).fill('fixture-secret-not-production')
 await page.getByRole('button',{name:'Save credential',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('input[type=password]').value==='')
 await page.getByText('Configuration saved',{exact:true}).waitFor()
 assert.equal(writes.filter(a=>a.type==='configure_telegram').length,1)
 assert.equal(writes[0].token,'fixture-secret-not-production')
 assert.equal(writes[0].enabled,false,'saving disabled configuration must not pretend a live channel')
 assert.ok(!(await page.content()).includes('fixture-secret-not-production'))
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0)
 await page.getByRole('button',{name:'Enable',exact:true}).click()
 await page.getByText('Identity verified · workers running',{exact:false}).waitFor()
 const first=page.getByRole('group',{name:'Controller grants',exact:true}).locator('li').filter({hasText:'telegram · 123 / 451'})
 await first.getByRole('button',{name:'Change scope',exact:true}).click()
 assert.equal(await page.getByRole('checkbox',{name:'Allow new sessions in this workspace Fixture workspace',exact:true}).isChecked(),false)
 await page.getByRole('combobox',{name:'Session',exact:true}).selectOption('s2')
 await page.getByRole('checkbox',{name:'Allow session Second workspace session',exact:true}).check()
 await page.getByRole('checkbox',{name:'Allow new sessions in this workspace Second workspace',exact:true}).check()
 assert.equal(await page.getByRole('checkbox',{name:'Allow workspace Second workspace',exact:true}).isDisabled(),true)
 conflict=true
 await page.getByRole('button',{name:'Save complete grant',exact:true}).click()
 await page.getByRole('alert').filter({hasText:'Configuration changed'}).waitFor()
 assert.equal(grants[0].principal.revision,1)
 await page.waitForTimeout(2700)
 await page.getByRole('alert').filter({hasText:'Configuration changed'}).waitFor()
 conflict=false
 await page.getByRole('button',{name:'Refresh',exact:true}).click()
 await page.getByRole('button',{name:'Save complete grant',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('section').textContent.includes('Other fixture session'))
 const savedScope=writes.filter(a=>a.type==='grant_scopes').at(-1)
 assert.equal(savedScope.expected.revision,1)
 assert.deepEqual(savedScope.workspaces,['w','w2']);assert.deepEqual(savedScope.sessions,['s','s2','t']);assert.deepEqual(savedScope.create_workspaces,['w2'])
 await first.getByRole('button',{name:'Change scope',exact:true}).click()
 assert.equal(await page.getByRole('checkbox',{name:'Allow session Fixture session',exact:true}).isChecked(),true)
 assert.equal(await page.getByRole('checkbox',{name:'Allow new sessions in this workspace Second workspace',exact:true}).isChecked(),true)
 await page.getByRole('checkbox',{name:'Allow new sessions in this workspace Second workspace',exact:true}).uncheck()
 await page.getByRole('button',{name:'Save complete grant',exact:true}).click()
 await page.getByText('Configuration saved',{exact:true}).waitFor()
 const disabledCreate=writes.filter(a=>a.type==='grant_scopes').at(-1)
 assert.equal(disabledCreate.expected.revision,2);assert.equal(disabledCreate.expected_creation_generation,1);assert.deepEqual(disabledCreate.create_workspaces,[])
 assert.deepEqual(disabledCreate.sessions,['s','s2','t'])
 await first.getByRole('button',{name:'Revoke permanently',exact:true}).click({trial:true})
 page.once('dialog',dialog=>dialog.accept())
 await first.getByRole('button',{name:'Revoke permanently',exact:true}).click()
 await first.getByText('Revoked',{exact:true}).waitFor()
 const second=page.getByRole('group',{name:'Controller grants',exact:true}).locator('li').filter({hasText:'telegram · 123 / 452'})
 await second.getByRole('button',{name:'Change scope',exact:true}).click()
 const unknownWorkspace=page.getByRole('checkbox',{name:/Unavailable selected scope: missing-workspace/}).first()
 const unknownCreation=page.getByRole('checkbox',{name:/Allow new sessions in this workspace.*Unavailable selected scope: missing-workspace/})
 const unknownSession=page.getByRole('checkbox',{name:/Unavailable selected scope: missing-session/})
 assert.equal(await unknownWorkspace.isChecked(),true);assert.equal(await unknownWorkspace.isDisabled(),true)
 assert.equal(await unknownSession.isChecked(),true);assert.equal(await unknownCreation.isChecked(),true)
 await unknownCreation.click();await unknownWorkspace.click();await unknownSession.click()
 assert.equal(await unknownCreation.count(),0);assert.equal(await unknownWorkspace.count(),0);assert.equal(await unknownSession.count(),0)
 await page.getByRole('button',{name:'Save complete grant',exact:true}).click()
 await page.getByText('Configuration saved',{exact:true}).waitFor()
 const removed=writes.filter(a=>a.type==='grant_scopes').at(-1)
 assert.deepEqual(removed.workspaces,['w']);assert.deepEqual(removed.sessions,['s']);assert.deepEqual(removed.create_workspaces,[]);assert.equal(removed.expected_creation_generation,7)
 assert.equal(await first.getByRole('button').count(),0)
 await page.getByRole('button',{name:'Record verified conclusion',exact:true}).click()
 await page.getByRole('textbox',{name:'Evidence SHA-256 (64 lowercase hexadecimal characters)',exact:true}).fill('a'.repeat(64))
 page.once('dialog',dialog=>dialog.accept())
 await page.getByRole('button',{name:'Record verified conclusion',exact:true}).last().click()
 await page.getByText('No uncertain sends need review.',{exact:true}).waitFor()
 const review=writes.find(a=>a.type==='resolve_reply')
 assert.equal(review.resolution.type,'abandon_without_replay');assert.equal(review.actor,undefined)
 const inboxSection=page.locator('fieldset').filter({has:page.locator('legend',{hasText:'Uncertain inbox outcomes'})})
 await inboxSection.getByRole('button',{name:'Load more inbox requests',exact:true}).click()
 await inboxSection.getByText(inboxRow(26).identity.key,{exact:true}).waitFor()
 const inboxReads=reads.filter(a=>a.type==='uncertain_inbox').length
 await page.waitForTimeout(2700);assert.equal(reads.filter(a=>a.type==='uncertain_inbox').length,inboxReads);await inboxSection.getByText(inboxRow(26).identity.key,{exact:true}).waitFor()
 assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_INPUT_AND_HANDLE'))
 await inboxSection.getByRole('button',{name:'Review inbox request',exact:true}).first().click()
 const conclusion=inboxSection.getByRole('combobox',{name:'Inbox review conclusion',exact:true})
 assert.deepEqual(await conclusion.locator('option').evaluateAll(options=>options.map(o=>o.value)),['abandon_without_replay','verified_not_applied'])
 assert.ok(await inboxSection.getByRole('button',{name:'Record inbox review',exact:true}).isDisabled())
 await inboxSection.getByRole('button',{name:'Cancel review',exact:true}).click()
 const row=inboxSection.locator('li').filter({has:page.getByText(inboxRow(2).identity.key,{exact:true})})
 await row.getByRole('button',{name:'Review inbox request',exact:true}).click()
 await conclusion.selectOption('observed_accepted');await inboxSection.getByRole('textbox',{name:'Inbox evidence SHA-256 (64 lowercase hexadecimal characters)',exact:true}).fill('b'.repeat(64))
 const beforeInboxWrites=writes.filter(a=>a.type==='resolve_inbox').length
 page.once('dialog',dialog=>dialog.accept());await inboxSection.getByRole('button',{name:'Record inbox review',exact:true}).click()
 await inboxSection.getByRole('button',{name:'Record inbox review',exact:true}).waitFor({state:'detached'})
 const observedInbox=writes.filter(a=>a.type==='resolve_inbox');assert.equal(observedInbox.length,beforeInboxWrites+1);assert.deepEqual(observedInbox.at(-1).expected,inboxRow(2).identity);assert.equal(observedInbox.at(-1).resolution,'observed_accepted');assert.equal(observedInbox.at(-1).actor,undefined)
 inboxOffline=true;await inboxSection.getByRole('button',{name:'Review inbox request',exact:true}).first().click();await inboxSection.getByRole('textbox',{name:'Inbox evidence SHA-256 (64 lowercase hexadecimal characters)',exact:true}).fill('c'.repeat(64));page.once('dialog',dialog=>dialog.accept());await inboxSection.getByRole('button',{name:'Record inbox review',exact:true}).click();await page.getByRole('alert').filter({hasText:'outcome is unknown'}).waitFor()
 const uncertainInboxWrites=writes.filter(a=>a.type==='resolve_inbox').length;await page.waitForTimeout(2700);assert.equal(writes.filter(a=>a.type==='resolve_inbox').length,uncertainInboxWrites);inboxOffline=false;await inboxSection.getByRole('button',{name:'Cancel review',exact:true}).click()
 offlineWrite=true
 await page.getByRole('button',{name:'Disable',exact:true}).click()
 await page.getByRole('alert').filter({hasText:'outcome is unknown'}).waitFor()
 const writeCount=writes.length
 await page.waitForTimeout(2700)
 assert.equal(writes.length,writeCount,'uncertain write must not retry during polling')
 await page.getByRole('alert').filter({hasText:'outcome is unknown'}).waitFor()
 offlineWrite=false
 const evidence=process.env.UI_REMOTE_EVIDENCE
 if(evidence)mkdirSync(evidence,{recursive:true})
 for(const [locale,width,dark] of [['en',1100,false],['zh',390,false],['en',390,true],['zh',1100,true]]){
  await page.evaluate(({locale,dark})=>{mount(true,locale);const b=document.body;b.style.setProperty('--color-bg-primary',dark?'#141414':'#fff');b.style.setProperty('--color-bg-secondary',dark?'#222':'#f5f5f5');b.style.setProperty('--color-text-primary',dark?'#eee':'#161616');b.style.setProperty('--color-text-secondary',dark?'#aaa':'#555');b.style.setProperty('--color-border',dark?'#555':'#ddd')},{locale,dark})
  await page.setViewportSize({width,height:900});await page.getByRole('textbox',{name:locale==='zh'?'Bot 数字 ID':'Numeric Bot ID'}).waitFor()
  assert.equal(await page.locator('.xr_remoteScope label').first().evaluate(el=>getComputedStyle(el).flexDirection),'row')
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow '+locale+width)
  const inputs=page.locator('input,button,select')
  for(let i=0;i<await inputs.count();i++){const box=await inputs.nth(i).boundingBox();if(box){assert.ok(box.x>=0&&box.x+box.width<=width+1,JSON.stringify(box));if(await inputs.nth(i).getAttribute('type')!=='checkbox')assert.ok(box.height>=35,engine+' minimum interactive height '+JSON.stringify(box))}}
  if(evidence){await page.screenshot({path:join(evidence,engine+'-'+locale+'-'+width+'-'+(dark?'dark':'light')+'.png'),fullPage:true});await page.locator('legend').filter({hasText:locale==='zh'?'收件箱不确定结果':'Uncertain inbox outcomes'}).scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,engine+'-'+locale+'-'+width+'-'+(dark?'dark':'light')+'-inbox.png')})}
 }
 notEnabled=true
 await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.getByRole('alert').filter({hasText:'服务未启用'}).waitFor()
 assert.equal(errors.length,0,JSON.stringify(errors))
 await page.evaluate(()=>root.unmount())
 const final=requests.length;await page.waitForTimeout(2700);assert.equal(requests.length,final,'unmount stops polling')
 console.log(engine+': actual view/client local gate, safe secret submission, scope CAS/revoke, inbox identity/audit/native-proof restriction/interaction sealing, recovery without replay, unknown outcome/no retry, pagination, bilingual monochrome responsive views, disabled-service and unmount passed (protocol fixtures only)')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));writes.length=0}
