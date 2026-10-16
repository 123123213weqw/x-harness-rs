/** Native-only feature-owned Settings section; no eager credential/status read. */
import type {SettingsRemoteContext,RemoteSettingsProps,Catalog} from './contracts'
import {createAdminClient,AdminFailure} from './api'
import {RemoteSettings} from './RemoteSettings'
import {en,zh} from './locales'
export const inject=['slots','locale','connection']
const NS='settings.remoteControl'
function sessionLabel(values:unknown,id:string):string{if(typeof values==='object'&&values!==null&&'title' in values&&typeof values.title==='string'&&values.title.trim())return values.title;return id}
export function apply(ctx:SettingsRemoteContext):void{
 ctx.effect(()=>ctx.locale.register(NS,{zh,en}),'remote-control: dictionaries')
 const connection=ctx.get('connection'),api=createAdminClient(),t=ctx.locale.bind(NS)
 const catalog=async():Promise<Catalog>=>{
  const [workspaces,sessions]=await Promise.all([connection.api.workspace.list({}),connection.api.sessions.list({})])
  if(!workspaces.result.ok||!sessions.result.ok)throw new AdminFailure('unavailable')
  const archived=new Set(workspaces.result.value.archivedSessionIds)
  return {workspaces:workspaces.result.value.items.map(w=>({id:w.workspaceId,title:w.title,sessions:w.sessionIds.filter(s=>!archived.has(s))})),sessions:Object.fromEntries(sessions.result.value.items.map(s=>[s.sessionId,sessionLabel(s.projections?.values,s.sessionId)]))}
 }
 const props=():RemoteSettingsProps=>({t,local:connection.isLoopback,api,catalog})
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'remote-control',order:35,label:()=>t('nav'),locale:NS,inject:props},RemoteSettings))
}
