/** Real source client, zero platform/model credentials or native-keyring writes. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {remoteSettingsModule} from './fixtures/remote-settings-module.mjs'
const require=createRequire(new URL('../ui/package.json',import.meta.url))
let factory
vm.runInNewContext(remoteSettingsModule(),{window:{__ModuleLoader__:{load:r=>{factory=r.factory}}},console,Error,TypeError,Promise,AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,fetch})
const api=factory(id=>require(id))
const bot={channel:'telegram',id:'123'},status={host:'host',manager:{state:'running'},credential_cleanup_pending:false,accounts:[{account:bot,enabled:false,revision:1,credential_reference_saved:true,connection:{state:'disabled'}}]}
const grant={principal:{id:'p',host:'host',sender:{channel:'telegram',account:'123',user:'456'},workspaces:['w'],sessions:['s'],revision:1,revoked:false},bindings:[{id:'b',principal:'p',conversation:'456',workspace:'w',session:'s',generation:1}]}
const response=value=>new Response(JSON.stringify({ok:true,value}),{headers:{'content-type':'application/json'}})
const rejects=(fn,code='invalid_response')=>assert.throws(fn,error=>error instanceof api.AdminFailure&&error.code===code)
test('bounded typed native reads drop extras and reject invalid identity, ownership and versions',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(api.decodeStatus({...status,token:'not-returned'}))),status)
 for(const value of [null,[],{}, {...status,accounts:Array(17).fill(status.accounts[0])}, {...status,host:'\u0000bad'}, {...status,accounts:[{...status.accounts[0],revision:Number.MAX_SAFE_INTEGER+1}]}, {...status,manager:{state:'pretend-online'}}])rejects(()=>api.decodeStatus(value))
 assert.equal(api.decodeGrants({items:[grant],next:null}).items[0].principal.id,'p')
 rejects(()=>api.decodeGrants({items:[{...grant,bindings:[{...grant.bindings[0],principal:'other'}]}],next:null}))
 rejects(()=>api.decodeGrants({items:Array(26).fill(grant),next:null}))
 rejects(()=>api.decodeRecovery({items:[],next:-1}))
 const recovery={key:'key',sequence:1,account:bot,sender:grant.principal.sender,principal:'p',binding:grant.bindings[0],failure:null,expected_message:null}
 assert.equal(api.decodeRecovery({items:[recovery],next:null}).items[0].key,'key')
 rejects(()=>api.decodeRecovery({items:[{...recovery,principal:'other'}],next:null}))
 rejects(()=>api.decodeRecovery({items:[{...recovery,account:{...bot,id:'other'}}],next:null}))
 assert.deepEqual(Object.keys(api.en).sort(),Object.keys(api.zh).sort())
})
test('mutation receipts certify the precise account/revision/scope/audit, never generic ok',()=>{
 const cases=[
 [{type:'configure_telegram',bot_id:'123',expected_revision:0,enabled:false,token:'fixture-secret'}, {account:bot,revision:1,credential_cleanup_pending:false}],
 [{type:'set_enabled',account:bot,expected_revision:1,enabled:true},{account:bot,revision:2,enabled:true}],
 [{type:'grant',account:bot,user:'456',workspace:'w',session:'s'},grant],
 [{type:'revoke',principal:'p'},{revoked:true,principal:'p'}],
 [{type:'cleanup_credentials'},{credential_cleanup_pending:false}],
 ]
 for(const [action,receipt] of cases){api.validateMutation(action,receipt);rejects(()=>api.validateMutation(action,{}))}
 rejects(()=>api.validateMutation(cases[0][0],{...cases[0][1],account:{...bot,id:'999'}}))
 rejects(()=>api.validateMutation(cases[1][0],{...cases[1][1],revision:1}))
 rejects(()=>api.validateMutation(cases[2][0],{...grant,principal:{...grant.principal,sessions:['other']}}))
 const update={...cases[2][0],expected:{principal:'p',binding:'b',revision:1,generation:1}}
 rejects(()=>api.validateMutation(update,grant))
 api.validateMutation(update,{principal:{...grant.principal,revision:2},bindings:[{...grant.bindings[0],generation:2}]})
 for(const [type,current] of [['observed_delivered','delivered'],['verified_not_sent','rejected'],['abandon_without_replay','abandoned']]){
  const action={type:'resolve_reply',key:'reply',evidence_sha256:'a'.repeat(64),resolution:type==='observed_delivered'?{type,receipt:{message_id:'42'}}:{type}}
  const receipt={sequence:1,previous:'uncertain',current,review:{key:action.key,actor:'authenticated-desktop',evidence_sha256:action.evidence_sha256,resolution:action.resolution}}
  api.validateMutation(action,receipt)
  rejects(()=>api.validateMutation(action,{...receipt,review:{...receipt.review,actor:'controller'}}))
  rejects(()=>api.validateMutation(action,{...receipt,current:'pending'}))
 }
})
test('native fetch is same-origin bounded no-store and writes once with validated receipts',async()=>{
 const calls=[],client=api.createAdminClient(async(url,options)=>{calls.push({url,options});return response({account:bot,revision:1,credential_cleanup_pending:false})})
 await client.mutate({type:'configure_telegram',bot_id:'123',expected_revision:0,enabled:false,token:'fixture-secret'})
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/remote-control/manage')
 const options=calls[0].options
 assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store')
 assert.equal(options.headers['x-xharness-remote-admin'],'v1')
 assert.ok(!calls[0].url.includes('fixture-secret'))
 const bad=api.createAdminClient(async()=>response({account:bot,revision:100,credential_cleanup_pending:false}))
 await assert.rejects(bad.mutate({type:'configure_telegram',bot_id:'123',expected_revision:0,enabled:false,token:'fixture-secret'}),e=>e.code==='invalid_response')
})
test('transport/HTML/provider errors are closed; ambiguous writes never retry',async()=>{
 for(const [fetcher,code] of [
  [async()=>{throw Error('fixture-secret upstream-body')},'connection_lost'],
  [async()=>new Response('fixture-secret',{status:500}),'invalid_response'],
  [async()=>new Response(JSON.stringify({ok:false,error:{code:'fixture-secret'}}),{status:500}),'unavailable'],
  [async()=>new Response('unmounted',{status:404}),'not_enabled'],
  [async()=>new Response('expired',{status:401}),'unauthorized'],
  [async()=>new Response('cross-site',{status:403}),'forbidden'],
  [async()=>new Response('x'.repeat(8*1024*1024+1)),'capacity'],
 ]){
  let count=0
  const client=api.createAdminClient(async(...args)=>{count++;return fetcher(...args)})
  await assert.rejects(client.mutate({type:'revoke',principal:'p'}),error=>error instanceof api.AdminFailure&&error.code===code&&!error.message.includes('fixture-secret'))
  assert.equal(count,1)
 }
})
test('feature-owned slot is lazy, desktop catalog is authoritative, archived sessions omitted',async()=>{
 const slots=[],reads=[],locales=[]
 const ctx={effect:fn=>fn(),locale:{register:(ns,d)=>locales.push({ns,d}),bind:()=>key=>key},slots:{inject:(name,fn)=>fn(),register:(spec,component)=>slots.push({spec,component})},get:name=>{assert.equal(name,'connection');return {isLoopback:true,api:{workspace:{list:async p=>{reads.push(p);return {result:{ok:true,value:{items:[{workspaceId:'w',title:'workspace',sessionIds:['s','archived']}],archivedSessionIds:['archived']}}}}},sessions:{list:async p=>{reads.push(p);return {result:{ok:true,value:{items:[{sessionId:'s',projections:{values:{title:'Durable session title'}}},{sessionId:'untitled'}]}}}}}}}}}
 api.apply(ctx);assert.equal(reads.length,0);assert.equal(slots.length,1);assert.equal(slots[0].spec.id,'remote-control');assert.equal(locales[0].ns,'settings.remoteControl')
 const props=slots[0].spec.inject();assert.equal(props.local,true)
 const catalog=await props.catalog()
 assert.equal(reads.length,2);assert.deepEqual(JSON.parse(JSON.stringify(catalog)),{workspaces:[{id:'w',title:'workspace',sessions:['s']}],sessions:{s:'Durable session title',untitled:'untitled'}})
})

test('complete scope receipts preserve exact lists and policy-generation CAS; stale capability stays inactive',()=>{
 const action={type:'grant_scopes',account:bot,user:'456',workspace:'w',session:'s',workspaces:['w','w2'],sessions:['s','s2'],create_workspaces:[],expected_creation_generation:null}
 const receipt={principal:{...grant.principal,workspaces:['w2','w'],sessions:['s2','s']},bindings:grant.bindings,creation_policy:{principal:'p',principal_revision:1,generation:1,workspaces:[]}}
 api.validateMutation(action,receipt)
 for(const value of [
  {...receipt,creation_policy:undefined},
  {...receipt,principal:{...receipt.principal,sessions:['s']}},
  {...receipt,principal:{...receipt.principal,sessions:['s','s']}},
  {...receipt,creation_policy:{...receipt.creation_policy,workspaces:['w2']}},
  {...receipt,creation_policy:{...receipt.creation_policy,generation:2}},
  {...receipt,creation_policy:{...receipt.creation_policy,principal:'other'}},
 ])rejects(()=>api.validateMutation(action,value))
 const update={...action,create_workspaces:['w2'],expected_creation_generation:1,expected:{principal:'p',revision:1,binding:'b',generation:1}}
 const updated={principal:{...receipt.principal,revision:2},bindings:[{...grant.bindings[0],generation:2}],creation_policy:{...receipt.creation_policy,principal_revision:2,generation:2,workspaces:['w2']}}
 api.validateMutation(update,updated)
 rejects(()=>api.validateMutation(update,{...updated,creation_policy:{...updated.creation_policy,principal_revision:1}}))
 rejects(()=>api.validateMutation({...action,sessions:['s','s']},receipt))
 const stale={...updated,principal:{...updated.principal,revision:3,workspaces:['w'],sessions:['s']}}
 assert.equal(api.decodeGrants({items:[stale],next:null}).items[0].creation_policy.principal_revision,2)
 rejects(()=>api.decodeGrants({items:[{...updated,creation_policy:{...updated.creation_policy,workspaces:['foreign']}}],next:null}))
 rejects(()=>api.decodeGrants({items:[{...updated,creation_policy:{...updated.creation_policy,principal_revision:3}}],next:null}))
})

const inboxIdentity=(n=1)=>({key:'remote-v1-'+n.toString(16).padStart(64,'0'),sequence:n,principal:'p',principal_revision:1,binding:grant.bindings[0],identity_sha256:'b'.repeat(64)})
const inboxEntry=(n=1,command='cancel')=>({identity:inboxIdentity(n),command,interaction:command==='answer_interaction'?'approval':null,observed_accepted_allowed:!['create_session','automation_control'].includes(command)})
test('inbox recovery exposes closed metadata only with exact ordered pagination and native proof restrictions',()=>{
 const entries=Array.from({length:25},(_,n)=>inboxEntry(n+1));const page=api.decodeInbox({items:entries,next:25,private:'PRIVATE_RAW'})
 assert.equal(page.items.length,25);assert.equal(page.next,25);assert.equal(JSON.stringify(page).includes('PRIVATE_RAW'),false)
 const row=inboxEntry();assert.equal(api.decodeInbox({items:[{...row,content:'PRIVATE_INPUT'}],next:null}).items[0].identity.sequence,1)
 for(const value of [{items:[row,row],next:null},{items:[inboxEntry(2),row],next:null},{items:[row],next:1},{items:entries,next:24},{items:entries.concat(inboxEntry(26)),next:25},{items:[{...row,command:'execute_rpc'}],next:null},{items:[{...row,interaction:'approval'}],next:null},{items:[{...inboxEntry(1,'answer_interaction'),interaction:null}],next:null},{items:[{...inboxEntry(1,'automation_control'),observed_accepted_allowed:true}],next:null},{items:[{...row,identity:{...row.identity,key:'\u0000invalid-key'}}],next:null},{items:[{...row,identity:{...row.identity,principal_revision:Number.MAX_SAFE_INTEGER+1}}],next:null}])rejects(()=>api.decodeInbox(value))
 rejects(()=>api.decodeInbox({items:[row],next:null},1));rejects(()=>api.decodeInbox({items:[],next:null},-1))
})
test('inbox review receipt must certify full expected identity, actor, evidence and terminal outcome',()=>{
 for(const [resolution,current] of [['observed_accepted','completed'],['verified_not_applied','rejected'],['abandon_without_replay','abandoned']]){
  const action={type:'resolve_inbox',expected:inboxIdentity(),evidence_sha256:'c'.repeat(64),resolution},receipt={identity:action.expected,audit:{sequence:1,previous:'uncertain',current,review:{delivery_key:action.expected.key,actor:'authenticated-desktop',evidence_sha256:action.evidence_sha256,resolution}}}
  api.validateMutation(action,receipt)
  for(const bad of [{}, {...receipt,identity:{...receipt.identity,principal_revision:2}}, {...receipt,identity:{...receipt.identity,binding:{...receipt.identity.binding,session:'foreign'}}}, {...receipt,audit:{...receipt.audit,current:'queued'}}, {...receipt,audit:{...receipt.audit,review:{...receipt.audit.review,actor:'controller'}}}, {...receipt,audit:{...receipt.audit,review:{...receipt.audit.review,evidence_sha256:'d'.repeat(64)}}}])rejects(()=>api.validateMutation(action,bad))
 }
})
test('inbox client reads bounded cursors and performs one uncertain write with no automatic retry',async()=>{
 let calls=0;const client=api.createAdminClient(async(_,options)=>{calls++;const a=JSON.parse(options.body);assert.equal(a.type,'uncertain_inbox');assert.equal(a.after,25);return response({items:[inboxEntry(26)],next:null})});assert.equal((await client.inboxRecovery(25)).items[0].identity.sequence,26);assert.equal(calls,1)
 const action={type:'resolve_inbox',expected:inboxIdentity(),evidence_sha256:'c'.repeat(64),resolution:'abandon_without_replay'};calls=0;const unknown=api.createAdminClient(async()=>{calls++;throw Error('PRIVATE_BODY')});await assert.rejects(unknown.mutate(action),e=>e.code==='connection_lost');assert.equal(calls,1)
})
