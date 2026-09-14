import {useEffect,useRef,useState,type FormEvent} from 'react'
import type {AccountView,Catalog,GrantEntry,GrantVersion,InboxEntry,InboxResolution,RecoveryEntry,RemoteSettingsProps,Status} from './contracts'
import {AdminFailure} from './api'
import './styles'
const toggle=(values:readonly string[],id:string)=>values.includes(id)?values.filter(value=>value!==id):[...values,id]
const union=(...values:readonly (readonly string[])[])=>[...new Set(values.flat())].sort()
const numeric=(s:string)=>/^[1-9][0-9]{0,18}$/.test(s)&&BigInt(s)<=9223372036854775807n
export function RemoteSettings({t,local,api,catalog}:RemoteSettingsProps){
 const [status,setStatus]=useState<Status>(),[grants,setGrants]=useState<readonly GrantEntry[]>([]),[moreGrants,setMoreGrants]=useState<string|null>(null)
 const [recovery,setRecovery]=useState<readonly RecoveryEntry[]>([]),[moreRecovery,setMoreRecovery]=useState<number|null>(null),[places,setPlaces]=useState<Catalog>()
 const [inbox,setInbox]=useState<readonly InboxEntry[]>([]),[moreInbox,setMoreInbox]=useState<number|null>(null),[inboxReview,setInboxReview]=useState<InboxEntry>(),[inboxResolution,setInboxResolution]=useState<InboxResolution>('abandon_without_replay'),[inboxEvidence,setInboxEvidence]=useState('')
 const [issue,setIssue]=useState<string>(),[mutationIssue,setMutationIssue]=useState<string>(),[notice,setNotice]=useState(false),[noticeKind,setNoticeKind]=useState('saved'),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true)
 const [bot,setBot]=useState(''),[token,setToken]=useState(''),[enabled,setEnabled]=useState(false)
 const [grantAccount,setGrantAccount]=useState(''),[user,setUser]=useState(''),[workspace,setWorkspace]=useState(''),[session,setSession]=useState(''),[expected,setExpected]=useState<GrantVersion>()
 const [allowedWorkspaces,setAllowedWorkspaces]=useState<readonly string[]>([]),[allowedSessions,setAllowedSessions]=useState<readonly string[]>([]),[createWorkspaces,setCreateWorkspaces]=useState<readonly string[]>([]),[creationGeneration,setCreationGeneration]=useState<number|null>(null)
 const [review,setReview]=useState<RecoveryEntry>(),[resolution,setResolution]=useState<'observed_delivered'|'verified_not_sent'|'abandon_without_replay'>('abandon_without_replay'),[evidence,setEvidence]=useState(''),[message,setMessage]=useState('')
 const live=useRef(false),reading=useRef(0),working=useRef(false),knownPlaces=useRef<Catalog>()
 const fail=(error:unknown)=>error instanceof AdminFailure?error.code:'unavailable'
 async function load(full=true){
  if(!local)return
  const generation=++reading.current
  try {
   const next=await api.status()
   if(!full&&knownPlaces.current){
    if(live.current&&generation===reading.current){setStatus(next);setIssue(undefined)}
    return
   }
   const [scopes,uncertain,unknown,known]=await Promise.all([api.grants(),api.recovery(),api.inboxRecovery(),catalog()])
   if(!live.current||generation!==reading.current)return
   setStatus(next);setGrants(scopes.items);setMoreGrants(scopes.next);setRecovery(uncertain.items);setMoreRecovery(uncertain.next)
   setInbox(unknown.items);setMoreInbox(unknown.next)
   knownPlaces.current=known;setPlaces(known);setIssue(undefined)
  }catch(error){if(live.current&&generation===reading.current)setIssue(fail(error))}finally{if(live.current&&generation===reading.current)setLoading(false)}
 }
 useEffect(()=>{live.current=true;if(local)void load();else setLoading(false)
  const poll=setInterval(()=>{if(!working.current)void load(false)},2500)
  return()=>{live.current=false;reading.current++;clearInterval(poll)}
 },[api,catalog,local])
 async function mutate(action:Parameters<typeof api.mutate>[0]){
  if(working.current)return false
  working.current=true;reading.current++;setBusy(true);setNotice(false);setIssue(undefined);setMutationIssue(undefined)
  try{await api.mutate(action);if(live.current){setNoticeKind(action.type==='resolve_inbox'?'inboxRecorded':'saved');setNotice(true);await load()}return true}
  catch(error){if(live.current)setMutationIssue(fail(error));return false}
  finally{working.current=false;if(live.current)setBusy(false)}
 }
 const selected=status?.accounts.find(a=>a.account.channel==='telegram'&&a.account.id===bot)
 const workspaceSessions=places?.workspaces.find(w=>w.id===workspace)?.sessions??[]
 function saveCredential(event:FormEvent){event.preventDefault();const secret=token;setToken('');void mutate({type:'configure_telegram',bot_id:bot,expected_revision:selected?.revision??0,enabled,token:secret})}
 function saveGrant(event:FormEvent){event.preventDefault();void mutate({type:'grant_scopes',account:{channel:'telegram',id:grantAccount},user,workspace,session,workspaces:union(allowedWorkspaces,createWorkspaces,[workspace]),sessions:union(allowedSessions,[session]),create_workspaces:createWorkspaces,expected_creation_generation:creationGeneration,...expected===undefined?{}:{expected}}).then(saved=>{if(saved&&live.current){setExpected(undefined);setUser('');setSession('');setAllowedWorkspaces([]);setAllowedSessions([]);setCreateWorkspaces([]);setCreationGeneration(null)}})}
 function edit(entry:GrantEntry){const b=entry.bindings[0];if(!b)return;setGrantAccount(entry.principal.sender.account);setUser(entry.principal.sender.user);setWorkspace(b.workspace);setSession(b.session);setAllowedWorkspaces(entry.principal.workspaces);setAllowedSessions(entry.principal.sessions);setCreateWorkspaces(entry.creation_policy?.principal_revision===entry.principal.revision?entry.creation_policy.workspaces:[]);setCreationGeneration(entry.creation_policy?.generation??null);setExpected({principal:entry.principal.id,revision:entry.principal.revision,binding:b.id,generation:b.generation})}
 function chooseAccount(account:AccountView){setBot(account.account.id);setToken('');setEnabled(account.enabled)}
 async function loadMore(kind:'grants'|'recovery'|'inbox'){
  if(working.current)return;working.current=true;reading.current++;setBusy(true)
  try{if(kind==='grants'&&moreGrants){const page=await api.grants(moreGrants);if(live.current){setGrants(current=>[...current,...page.items.filter(e=>!current.some(c=>c.principal.id===e.principal.id))]);setMoreGrants(page.next)}}
   if(kind==='inbox'&&moreInbox!==null){const page=await api.inboxRecovery(moreInbox);if(live.current){setInbox(current=>[...current,...page.items.filter(e=>!current.some(c=>c.identity.key===e.identity.key))]);setMoreInbox(page.next)}}
   if(kind==='recovery'&&moreRecovery!==null){const page=await api.recovery(moreRecovery);if(live.current){setRecovery(current=>[...current,...page.items.filter(e=>!current.some(c=>c.key===e.key))]);setMoreRecovery(page.next)}}
  }catch(error){if(live.current)setIssue(fail(error))}finally{working.current=false;if(live.current)setBusy(false)}
 }
 const visibleIssue=mutationIssue??issue
 if(!local)return <section className="xr_remoteRoot"><h2>{t('title')}</h2><p>{t('localOnly')}</p></section>
 return <section className="xr_remoteRoot" aria-busy={busy||loading}>
  <header className="xr_remoteHeader"><div><h2>{t('title')}</h2><p>{t('subtitle')}</p></div><button disabled={busy} onClick={()=>{setLoading(true);setMutationIssue(undefined);setNotice(false);void load()}}>{t('refresh')}</button></header>
  {loading&&<p role="status">{t('loading')}</p>}
  {visibleIssue&&<p className="xr_remoteMessage" role="alert">{t(visibleIssue)}</p>}
  {notice&&<p role="status">{t(noticeKind)}</p>}
  {status&&<>
   <p className="xr_remoteMeta">{t('manager')}: {t(status.manager.state)} · Host <code>{status.host}</code></p>
   {status.credential_cleanup_pending&&<div className="xr_remoteMessage"><p>{t('cleanupPending')}</p><button disabled={busy} onClick={()=>void mutate({type:'cleanup_credentials'})}>{t('cleanup')}</button></div>}
   <fieldset disabled={busy}><legend>{t('accounts')}</legend>
    {!status.accounts.length&&<p>{t('emptyAccounts')}</p>}
    <ul className="xr_remoteList">{status.accounts.map(a=><li key={a.account.channel+':'+a.account.id}><div><strong>{a.account.channel} · {a.account.id}</strong><p>{t(a.connection.state)} · {t('revision')} {a.revision}</p>{a.connection.state==='failed'&&<p>{t(a.connection.reason==='native_credential_unavailable'?'native_credentials_unavailable':a.connection.reason==='invalid_credentials'?'invalid_input':'unavailable')}</p>}</div><div className="xr_remoteActions"><button disabled={a.account.channel!=='telegram'} onClick={()=>chooseAccount(a)}>{t('rotate')}</button><button onClick={()=>void mutate({type:'set_enabled',account:a.account,expected_revision:a.revision,enabled:!a.enabled})}>{t(a.enabled?'disable':'enable')}</button></div></li>)}</ul>
    <form onSubmit={saveCredential} className="xr_remoteForm"><label>{t('botId')}<input aria-label={t('botId')} inputMode="numeric" value={bot} onChange={e=>{setBot(e.target.value);setToken('')}} required/></label>
     <label>{t('token')}<input aria-label={t('token')} type="password" autoComplete="off" spellCheck={false} value={token} onChange={e=>setToken(e.target.value)} maxLength={256} required/></label><small>{t('tokenHint')}</small>
     <label className="xr_remoteCheck"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>{t('enabled')}</label><button type="submit" disabled={!numeric(bot)||!token}>{t('save')}</button></form>
   </fieldset>
   <fieldset disabled={busy}><legend>{t('grants')}</legend><p>{t('scopeHint')}</p>
    {!grants.length&&<p>{t('emptyGrants')}</p>}
    <ul className="xr_remoteList">{grants.map(e=><li key={e.principal.id}><div><strong>{e.principal.sender.channel} · {e.principal.sender.account} / {e.principal.sender.user}</strong><p>{e.principal.revoked?t('revoked'):e.bindings.map(b=>(places?.workspaces.find(w=>w.id===b.workspace)?.title??b.workspace)+' / '+(places?.sessions[b.session]??b.session)).join(' · ')}</p><small>{t('revision')} {e.principal.revision} · {e.principal.sessions.length} {t('allowedSessions')} · {e.creation_policy?.principal_revision===e.principal.revision&&e.creation_policy.workspaces.length?t('createAllowed'):t('createDisabled')}</small></div>{!e.principal.revoked&&<div className="xr_remoteActions"><button disabled={e.principal.sender.channel!=='telegram'||e.bindings.length!==1} onClick={()=>edit(e)}>{t('editScope')}</button><button onClick={()=>{if(globalThis.confirm(t('confirmRevoke')))void mutate({type:'revoke',principal:e.principal.id})}}>{t('revoke')}</button></div>}</li>)}</ul>
    {moreGrants&&<button onClick={()=>void loadMore('grants')}>{t('more')}</button>}
    <form onSubmit={saveGrant} className="xr_remoteForm"><label>{t('account')}<select aria-label={t('account')} value={grantAccount} disabled={expected!==undefined} onChange={e=>setGrantAccount(e.target.value)}><option value="">{t('choose')}</option>{status.accounts.filter(a=>a.account.channel==='telegram').map(a=><option key={a.account.id} value={a.account.id}>Telegram {a.account.id}</option>)}</select></label>
     <label>{t('userId')}<input aria-label={t('userId')} inputMode="numeric" value={user} disabled={expected!==undefined} onChange={e=>setUser(e.target.value)} required/></label>
     <label>{t('workspace')}<select aria-label={t('workspace')} value={workspace} onChange={e=>{setWorkspace(e.target.value);setSession('')}}><option value="">{t('choose')}</option>{places?.workspaces.map(w=><option key={w.id} value={w.id}>{w.title}</option>)}</select></label>
     <label>{t('session')}<select aria-label={t('session')} value={session} onChange={e=>setSession(e.target.value)}><option value="">{t('choose')}</option>{workspaceSessions.map(s=><option key={s} value={s}>{places?.sessions[s]??s}</option>)}</select></label>
     <div className="xr_remoteScopes"><h3>{t('allowedScopes')}</h3><p>{t('createHint')}</p>
      {places?.workspaces.map(w=><div key={w.id} className="xr_remoteScope"><label><input type="checkbox" aria-label={t('allowWorkspace')+' '+w.title} checked={w.id===workspace||allowedWorkspaces.includes(w.id)||createWorkspaces.includes(w.id)} disabled={w.id===workspace||createWorkspaces.includes(w.id)||w.sessions.some(s=>s===session||allowedSessions.includes(s))} onChange={()=>setAllowedWorkspaces(current=>toggle(current,w.id))}/>{w.title}</label>
       <label><input type="checkbox" aria-label={t('allowCreate')+' '+w.title} checked={createWorkspaces.includes(w.id)} onChange={()=>setCreateWorkspaces(current=>toggle(current,w.id))}/>{t('allowCreate')}</label>
       {w.sessions.map(s=><label key={s}><input type="checkbox" aria-label={t('allowSession')+' '+(places?.sessions[s]??s)} checked={s===session||allowedSessions.includes(s)} disabled={s===session} onChange={()=>{setAllowedSessions(current=>toggle(current,s));if(!allowedSessions.includes(s))setAllowedWorkspaces(current=>union(current,[w.id]))}}/>{places?.sessions[s]??s}</label>)}
      </div>)}
      {allowedWorkspaces.filter(w=>!places?.workspaces.some(known=>known.id===w)).map(w=><label key={w}><input type="checkbox" checked disabled={w===workspace||createWorkspaces.includes(w)} onChange={()=>setAllowedWorkspaces(current=>toggle(current,w))}/>{t('unavailableScope')}: {w}</label>)}
      {createWorkspaces.filter(w=>!places?.workspaces.some(known=>known.id===w)).map(w=><label key={'create:'+w}><input type="checkbox" checked onChange={()=>setCreateWorkspaces(current=>toggle(current,w))}/>{t('allowCreate')} · {t('unavailableScope')}: {w}</label>)}
      {allowedSessions.filter(s=>!places?.workspaces.some(w=>w.sessions.includes(s))).map(s=><label key={s}><input type="checkbox" checked disabled={s===session} onChange={()=>setAllowedSessions(current=>toggle(current,s))}/>{t('unavailableScope')}: {s}</label>)}
     </div>
     <button type="submit" disabled={!grantAccount||!numeric(user)||!workspaceSessions.includes(session)}>{t('grant')}</button>
     {expected&&<button type="button" onClick={()=>{setExpected(undefined);setUser('');setSession('');setAllowedWorkspaces([]);setAllowedSessions([]);setCreateWorkspaces([]);setCreationGeneration(null)}}>{t('choose')}</button>}
    </form>
   </fieldset>
   <fieldset disabled={busy}><legend>{t('inboxRecovery')}</legend><p>{t('inboxHint')}</p>{!inbox.length&&<p>{t('emptyInbox')}</p>}
    <ul className="xr_remoteList">{inbox.map(r=><li key={r.identity.key}><div><strong>{t('command_'+r.command)}</strong><p>{t('principalId')}: <code>{r.identity.principal}</code> · {t('revision')} {r.identity.principal_revision}</p><p>{t('workspace')}: {r.identity.binding.workspace} · {t('sessionId')}: {r.identity.binding.session} · {t('bindingGeneration')} {r.identity.binding.generation}</p>{r.interaction&&<p>{t('interactionSealed')}</p>}{!r.observed_accepted_allowed&&<p>{t('originalProofRequired')}</p>}<code>{r.identity.key}</code></div><button onClick={()=>{setInboxReview(r);setInboxEvidence('');setInboxResolution('abandon_without_replay')}}>{t('reviewInbox')}</button></li>)}</ul>
    {moreInbox!==null&&<button onClick={()=>void loadMore('inbox')}>{t('moreInbox')}</button>}
    {inboxReview&&<form className="xr_remoteForm" onSubmit={e=>{e.preventDefault();if(!globalThis.confirm(t('confirmInbox')))return;void mutate({type:'resolve_inbox',expected:inboxReview.identity,evidence_sha256:inboxEvidence,resolution:inboxResolution}).then(saved=>{if(saved&&live.current)setInboxReview(undefined)})}}><code>{inboxReview.identity.key}</code>
     <label>{t('inboxResolution')}<select aria-label={t('inboxResolution')} value={inboxResolution} onChange={e=>{const v=e.target.value;if(v==='abandon_without_replay'||v==='verified_not_applied'||(v==='observed_accepted'&&inboxReview.observed_accepted_allowed))setInboxResolution(v)}}><option value="abandon_without_replay">{t('abandonInbox')}</option><option value="verified_not_applied">{t('notApplied')}</option>{inboxReview.observed_accepted_allowed&&<option value="observed_accepted">{t('observedAccepted')}</option>}</select></label>
     <label>{t('inboxEvidence')}<input aria-label={t('inboxEvidence')} value={inboxEvidence} onChange={e=>setInboxEvidence(e.target.value)} maxLength={64} spellCheck={false}/></label>
     <button type="submit" disabled={!/^[0-9a-f]{64}$/.test(inboxEvidence)}>{t('recordInbox')}</button><button type="button" onClick={()=>setInboxReview(undefined)}>{t('cancelReview')}</button>
    </form>}
   </fieldset>
   <fieldset disabled={busy}><legend>{t('recovery')}</legend><p>{t('recoveryHint')}</p>{!recovery.length&&<p>{t('emptyRecovery')}</p>}
    <ul className="xr_remoteList">{recovery.map(r=><li key={r.key}><div><strong>{r.account.channel} · {r.account.id} / {r.sender.user}</strong><p>{t('sessionId')}: {r.binding.session}</p><code>{r.key}</code></div><button onClick={()=>{setReview(r);setEvidence('');setMessage('');setResolution('abandon_without_replay')}}>{t('resolve')}</button></li>)}</ul>
    {moreRecovery!==null&&<button onClick={()=>void loadMore('recovery')}>{t('more')}</button>}
    {review&&<form className="xr_remoteForm" onSubmit={e=>{e.preventDefault();if(!globalThis.confirm(t('confirmResolve')))return;void mutate({type:'resolve_reply',key:review.key,evidence_sha256:evidence,resolution:resolution==='observed_delivered'?{type:resolution,receipt:{message_id:message}}:{type:resolution}}).then(saved=>{if(saved&&live.current)setReview(undefined)})}}><code>{review.key}</code>
     <label>{t('resolution')}<select value={resolution} onChange={e=>{const value=e.target.value;if(value==='observed_delivered'||value==='verified_not_sent'||value==='abandon_without_replay')setResolution(value)}}><option value="abandon_without_replay">{t('abandon')}</option><option value="verified_not_sent">{t('notSent')}</option><option value="observed_delivered">{t('observed')}</option></select></label>
     <label>{t('evidence')}<input aria-label={t('evidence')} value={evidence} onChange={e=>setEvidence(e.target.value)} maxLength={64} spellCheck={false}/></label>
     {resolution==='observed_delivered'&&<label>{t('messageId')}<input value={message} onChange={e=>setMessage(e.target.value)} maxLength={512}/></label>}
     <button disabled={!/^[0-9a-f]{64}$/.test(evidence)||(resolution==='observed_delivered'&&!message)}>{t('resolve')}</button>
    </form>}
   </fieldset>
   <fieldset><legend>{t('otherChannels')}</legend><p>Mobile Web · Weixin iLink · Feishu · Lark</p><small>{t('notImplemented')}</small></fieldset>
  </>}
 </section>
}
