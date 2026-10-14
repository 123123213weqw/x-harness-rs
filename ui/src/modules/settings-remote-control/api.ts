/** Dedicated native-only JSON extension: no generic RPC or secret persistence. */
import type {Account,AccountView,Action,Binding,ConnectionState,CreationPolicy,GrantEntry,GrantPage,InboxIdentity,InboxEntry,InboxPage,InboxCommand,Principal,RecoveryEntry,RecoveryPage,RemoteAdminClient,Status} from './contracts'
const ERRORS=['not_enabled','unauthorized','forbidden','capacity','conflict','invalid_input','unconfigured_account','native_credentials_unavailable','cleanup_required','unavailable','invalid_response','connection_lost'] as const
export type FailureCode=typeof ERRORS[number]
export class AdminFailure extends Error {constructor(readonly code:FailureCode){super(code)}}
function isRecord(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v)}
const record=(v:unknown):Record<string,unknown>=>{if(!isRecord(v))throw new AdminFailure('invalid_response');return v}
const string=(v:unknown):string=>{if(typeof v!=='string'||!v.length||v.length>512||/[\u0000-\u001f\u007f]/u.test(v))throw new AdminFailure('invalid_response');return v}
const number=(v:unknown):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new AdminFailure('invalid_response');return v}
const bool=(v:unknown):boolean=>{if(typeof v!=='boolean')throw new AdminFailure('invalid_response');return v}
const array=(v:unknown,max:number):unknown[]=>{if(!Array.isArray(v)||v.length>max)throw new AdminFailure('invalid_response');return v.map((item:unknown)=>item)}
const channel=(v:unknown):Account['channel']=>{if(v==='telegram'||v==='feishu'||v==='lark'||v==='weixin'||v==='mobile_web')return v;throw new AdminFailure('invalid_response')}
const account=(v:unknown):Account=>{const r=record(v);return {channel:channel(r.channel),id:string(r.id)}}
function connection(v:unknown):ConnectionState {const r=record(v);if(r.state==='failed')return {state:'failed',reason:string(r.reason)};if(r.state==='disabled'||r.state==='starting'||r.state==='online'||r.state==='stopped')return {state:r.state};throw new AdminFailure('invalid_response')}
function binding(v:unknown):Binding {const r=record(v);return {id:string(r.id),principal:string(r.principal),conversation:string(r.conversation),workspace:string(r.workspace),session:string(r.session),generation:number(r.generation)}}
function principal(v:unknown):Principal {const r=record(v),s=record(r.sender);return {id:string(r.id),host:string(r.host),sender:{channel:channel(s.channel),account:string(s.account),user:string(s.user)},workspaces:uniqueIds(r.workspaces,256),sessions:uniqueIds(r.sessions,4096),revision:number(r.revision),revoked:bool(r.revoked)}}
function uniqueIds(v:unknown,max:number):string[]{const ids=array(v,max).map(string);if(new Set(ids).size!==ids.length)throw new AdminFailure('invalid_response');return ids}
function creation(v:unknown,p:Principal):CreationPolicy {const r=record(v),c={principal:string(r.principal),principal_revision:number(r.principal_revision),generation:number(r.generation),workspaces:uniqueIds(r.workspaces,256)};if(c.principal!==p.id||c.principal_revision<1||c.principal_revision>p.revision||c.generation<1||(c.principal_revision===p.revision&&c.workspaces.some(w=>!p.workspaces.includes(w))))throw new AdminFailure('invalid_response');return c}
export function decodeStatus(raw:unknown):Status {const r=record(raw),m=record(r.manager);const manager:Status['manager']=m.state==='dormant'||m.state==='running'?{state:m.state}:connection(m);return {host:string(r.host),manager,credential_cleanup_pending:bool(r.credential_cleanup_pending),accounts:array(r.accounts,16).map((v):AccountView=>{const a=record(v);return {account:account(a.account),revision:number(a.revision),enabled:bool(a.enabled),credential_reference_saved:bool(a.credential_reference_saved),connection:connection(a.connection)}})}}
export function decodeGrants(raw:unknown):GrantPage {const r=record(raw);return {items:array(r.items,25).map((v):GrantEntry=>{const g=record(v),p=principal(g.principal),bindings=array(g.bindings,32).map(binding);if(bindings.some(b=>b.principal!==p.id))throw new AdminFailure('invalid_response');return {principal:p,bindings,...g.creation_policy===undefined?{}:{creation_policy:creation(g.creation_policy,p)}}}),next:r.next===null?null:string(r.next)}}
export function decodeRecovery(raw:unknown):RecoveryPage {const r=record(raw);return {items:array(r.items,25).map((v):RecoveryEntry=>{const e=record(v),s=record(e.sender),a=account(e.account),b=binding(e.binding),p=string(e.principal),sender={channel:channel(s.channel),account:string(s.account),user:string(s.user)};if(b.principal!==p||sender.channel!==a.channel||sender.account!==a.id)throw new AdminFailure('invalid_response');return {key:string(e.key),sequence:number(e.sequence),account:a,sender,principal:p,binding:b,failure:e.failure===null?null:string(e.failure),expected_message:e.expected_message===null?null:string(e.expected_message)}}),next:r.next===null?null:number(r.next)}}
const digest=(v:unknown):string=>{const s=string(v);if(!/^[0-9a-f]{64}$/.test(s))throw new AdminFailure('invalid_response');return s}
function inboxIdentity(raw:unknown):InboxIdentity {const r=record(raw),b=binding(r.binding),identity={key:string(r.key),sequence:number(r.sequence),principal:string(r.principal),principal_revision:number(r.principal_revision),binding:b,identity_sha256:digest(r.identity_sha256)};if(identity.sequence<1||identity.principal_revision<1||b.generation<1||b.principal!==identity.principal)throw new AdminFailure('invalid_response');return identity}
function inboxCommand(v:unknown):InboxCommand {if(v==='prompt'||v==='cancel'||v==='history'||v==='catalogue'||v==='select'||v==='create_session'||v==='automation_read'||v==='automation_control'||v==='answer_interaction')return v;throw new AdminFailure('invalid_response')}
export function decodeInbox(raw:unknown,after=0):InboxPage {
 const r=record(raw),items=array(r.items,25).map((v):InboxEntry=>{const e=record(v),identity=inboxIdentity(e.identity),command=inboxCommand(e.command),allowed=bool(e.observed_accepted_allowed);let interaction:InboxEntry['interaction']=null
  if(e.interaction==='approval'||e.interaction==='question')interaction=e.interaction;else if(e.interaction!==null)throw new AdminFailure('invalid_response')
  if((command==='answer_interaction')!==(interaction!==null)||allowed!==(command!=='create_session'&&command!=='automation_control'))throw new AdminFailure('invalid_response')
  return {identity,command,interaction,observed_accepted_allowed:allowed}
 }),next=r.next===null?null:number(r.next)
 if(!Number.isSafeInteger(after)||after<0||items.some((e,index)=>e.identity.sequence<=(items[index-1]?.identity.sequence??after))||new Set(items.map(e=>e.identity.key)).size!==items.length||(next!==null&&(items.length!==25||next!==items.at(-1)?.identity.sequence)))throw new AdminFailure('invalid_response')
 return {items,next}
}
export function validateMutation(action:Parameters<RemoteAdminClient['mutate']>[0],raw:unknown):void {
 const r=record(raw),invalid=():never=>{throw new AdminFailure('invalid_response')}
 const sameAccount=(actual:unknown,wanted:Account)=>{const a=account(actual);if(a.channel!==wanted.channel||a.id!==wanted.id)invalid()}
 switch(action.type){
  case 'configure_telegram':
   sameAccount(r.account,{channel:'telegram',id:action.bot_id});if(number(r.revision)!==action.expected_revision+1)invalid();bool(r.credential_cleanup_pending);break
  case 'set_enabled':
   sameAccount(r.account,action.account);if(number(r.revision)!==action.expected_revision+1||bool(r.enabled)!==action.enabled)invalid();break
  case 'grant':{
   const entry=decodeGrants({items:[raw],next:null}).items[0]
   if(!entry)throw new AdminFailure('invalid_response')
   const p=entry.principal,b=entry.bindings[0]
   if(!b)throw new AdminFailure('invalid_response')
   if(entry.bindings.length!==1||p.revoked||p.sender.channel!==action.account.channel||p.sender.account!==action.account.id||p.sender.user!==action.user||p.workspaces.length!==1||p.workspaces[0]!==action.workspace||p.sessions.length!==1||p.sessions[0]!==action.session||b.workspace!==action.workspace||b.session!==action.session||b.conversation!==action.user)invalid()
   if(action.expected){if(p.id!==action.expected.principal||p.revision!==action.expected.revision+1||b.id!==action.expected.binding||b.generation!==action.expected.generation+1)invalid()}
   else if(p.revision!==1||b.generation!==1)invalid()
   break
  }
  case 'grant_scopes':{
   const entry=decodeGrants({items:[raw],next:null}).items[0];if(!entry)throw new AdminFailure('invalid_response')
   const p=entry.principal,b=entry.bindings[0],c=entry.creation_policy;if(!b||!c)throw new AdminFailure('invalid_response')
   const sameIds=(actual:readonly string[],wanted:readonly string[])=>{const ids=uniqueIds(wanted,4096);return actual.length===ids.length&&actual.every(id=>ids.includes(id))}
   if(entry.bindings.length!==1||p.revoked||p.sender.channel!==action.account.channel||p.sender.account!==action.account.id||p.sender.user!==action.user||!sameIds(p.workspaces,action.workspaces)||!sameIds(p.sessions,action.sessions)||b.workspace!==action.workspace||b.session!==action.session||b.conversation!==action.user||!p.workspaces.includes(b.workspace)||!p.sessions.includes(b.session)||!sameIds(c.workspaces,action.create_workspaces)||c.principal_revision!==p.revision||c.generation!==(action.expected_creation_generation??0)+1)invalid()
   if(action.expected){if(p.id!==action.expected.principal||p.revision!==action.expected.revision+1||b.id!==action.expected.binding||b.generation!==action.expected.generation+1)invalid()}
   else if(p.revision!==1||b.generation!==1)invalid()
   break
  }
  case 'revoke':if(bool(r.revoked)!==true||string(r.principal)!==action.principal)invalid();break
  case 'cleanup_credentials':bool(r.credential_cleanup_pending);break
  case 'resolve_inbox':{
   const expected=inboxIdentity(action.expected),identity=inboxIdentity(r.identity),a=record(r.audit),review=record(a.review)
   if(JSON.stringify(identity)!==JSON.stringify(expected)||number(a.sequence)<1||a.previous!=='uncertain'||string(review.delivery_key)!==expected.key||review.actor!=='authenticated-desktop'||digest(review.evidence_sha256)!==action.evidence_sha256||review.resolution!==action.resolution||a.current!==(action.resolution==='observed_accepted'?'completed':action.resolution==='verified_not_applied'?'rejected':'abandoned'))invalid()
   break
  }
  case 'resolve_reply':{
   const review=record(r.review),resolution=record(review.resolution)
   if(number(r.sequence)<1||r.previous!=='uncertain'||string(review.key)!==action.key||review.actor!=='authenticated-desktop'||review.evidence_sha256!==action.evidence_sha256||resolution.type!==action.resolution.type)invalid()
   if(action.resolution.type==='observed_delivered'){if(r.current!=='delivered'||string(record(resolution.receipt).message_id)!==action.resolution.receipt.message_id)invalid()}
   else if(r.current!==(action.resolution.type==='verified_not_sent'?'rejected':'abandoned'))invalid()
   break
  }
 }
}
export function createAdminClient(fetcher:typeof fetch=globalThis.fetch):RemoteAdminClient {
 async function request(action:Action):Promise<unknown>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),75_000)
  try {
   const response=await fetcher('/api/remote-control/manage',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'content-type':'application/json','x-xharness-remote-admin':'v1'},body:JSON.stringify(action),signal:abort.signal})
   if(response.status===404)throw new AdminFailure('not_enabled')
   if(response.status===401)throw new AdminFailure('unauthorized')
   if(response.status===403)throw new AdminFailure('forbidden')
   if(response.status===413)throw new AdminFailure('capacity')
   // A bounded reader never trusts response Content-Length or unscoped text.
   const reader=response.body?.getReader();if(!reader)throw new AdminFailure('invalid_response')
   const chunks:Uint8Array[]=[];let size=0
   try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8*1024*1024){await reader.cancel();throw new AdminFailure('capacity')}chunks.push(part.value)}}finally{reader.releaseLock()}
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
   let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new AdminFailure('invalid_response')}
   const envelope=record(raw)
   if(!response.ok||envelope.ok!==true){const code=record(envelope.error).code;throw new AdminFailure(ERRORS.find(known=>known===code)??'unavailable')}
   return envelope.value
  }catch(error){if(error instanceof AdminFailure)throw error;throw new AdminFailure('connection_lost')}finally{clearTimeout(timer)}
 }
 return {status:async()=>decodeStatus(await request({type:'status'})),grants:async(after)=>decodeGrants(await request(after===undefined?{type:'grants'}:{type:'grants',after})),recovery:async(after=0)=>decodeRecovery(await request({type:'uncertain_replies',after})),inboxRecovery:async(after=0)=>decodeInbox(await request({type:'uncertain_inbox',after}),after),mutate:async(action)=>{validateMutation(action,await request(action))}}
}
