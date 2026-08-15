import {observeShellPage} from '../shared/shell-route'
/// <reference path="../shared/assets.d.ts" />
import {useEffect,useState,useSyncExternalStore,useRef} from 'react'
import {Tooltip} from '@xharness/dsh-client-ui-primitives'
import type {ClientContext} from '../views-types'
import type {IWorkspaces} from '../client-runtime/contract/workspaces'
import {GlobalAssistant} from './service'
import type {AssistantSessions,AssistantConversation} from './service'
import {ASSISTANT_OPEN,assistantReference,openAssistant} from './contracts'
import CSS from './Assistant.css'
import {OrbitIcon} from './OrbitIcon'
const zh=navigator.language.startsWith('zh')
const label=(en:string,cn:string):string=>zh?cn:en
function AssistantNavigation({wide}:{wide:boolean}) {
  const [active,setActive]=useState(false)
  useEffect(()=>observeShellPage('assistant',setActive),[])
  return <Tooltip label={label('Little X','小 X')} side="right" disabled={wide}><button type="button" data-xharness-assistant-nav className="xhassistant-nav" aria-label={label('Little X','小 X')} aria-current={active?'page':undefined} onClick={()=>openAssistant()}><OrbitIcon size={wide?16:18}/>{wide&&<span>X</span>}</button></Tooltip>
}
export function AssistantCenter({service,showConversation}:{service:GlobalAssistant;showConversation(visible:boolean):void}) {
  const state=useSyncExternalStore(service.state.subscribe,service.state.getSnapshot)
  const [workspace,setWorkspace]=useState(''),[tasks,setTasks]=useState(false)
  const alive=useRef(true)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{showConversation(state.exists&&state.active);return()=>showConversation(false)},[state.exists,state.active,showConversation])
  const runCount=state.tasks.filter(t=>t.status==='running').length,waiting=state.tasks.filter(t=>['approval','question','plan-review'].includes(t.status)).length
  return <section className="xhassistant" aria-label={label('Little X','小 X')}>
    <header><div className="xhassistant-title"><OrbitIcon size={20}/><strong>{label('Little X','小 X')}</strong></div><div className="xhassistant-controls"><button type="button" aria-expanded={tasks} onClick={()=>setTasks(!tasks)}>{label('Tasks','任务')}{state.ready?` · ${runCount} ${label('running','运行中')}${waiting?` / ${waiting} ${label('waiting','等待你')}`:''}`:''}</button>{state.exists&&state.active&&<button type="button" disabled={!state.ready} onClick={()=>service.shareTasks()}>{label('Share overview','引用任务概览')}</button>}</div></header>
    {state.error&&<p role="alert">{state.error}</p>}
    {tasks&&<div className="xhassistant-task-list" aria-label={label('Task overview','任务概览')}>
      {!state.ready?<p role="status">{label('Loading Host tasks…','正在加载 Host 任务…')}</p>:state.tasks.length?state.tasks.map(task=><button type="button" key={task.id} onClick={()=>service.openTask(task.id)}><span>{task.title}</span><small>{task.status==='approval'?label('Waiting for approval','等待审批'):task.status==='question'?label('Waiting for reply','等待回答'):task.status==='plan-review'?label('Waiting for plan review','等待计划确认'):task.status==='running'?label('Running','运行中'):task.status==='completed'?label('Turn finished','轮次结束'):label('Idle','空闲')}</small></button>):<p>{label('No other listed tasks','暂无其他已列出的任务')}</p>}{state.hasMore&&<p>{label('Showing the first 200 listed tasks.','显示前 200 个已列出的任务。')}</p>}
    </div>}
    {state.pending>0&&<div className="xhassistant-references"><span>{state.pending} {label('pending references','条待加入的引用')}</span><button disabled={!state.active} onClick={()=>service.appendPending()}>{label('Add to draft','加入草稿')}</button><button onClick={()=>service.discardPending()}>{label('Discard','丢弃')}</button></div>}
    {!state.exists&&<div className="xhassistant-setup"><OrbitIcon size={36}/><h2>{label('One place to coordinate your work','在这里统筹你的工作')}</h2><p>{label('Choose Little X’s working directory. Existing tasks keep their own conversations.','选择小 X 的工作目录，已有任务仍保留独立对话。')}</p><label>{label('Workspace','工作区')}<select aria-label={label('Little X workspace','小 X 工作区')} value={workspace} disabled={!state.ready||state.creating} onChange={e=>setWorkspace(e.target.value)}><option value="">{label('Choose workspace','选择工作区')}</option>{state.workspaces.map(w=><option key={w.id} value={w.id}>{w.title} · {w.path}</option>)}</select></label><button disabled={!workspace||!state.ready||state.creating} onClick={()=>void service.create(workspace).then(()=>{if(alive.current&&service.state.getSnapshot().exists)service.open()})}>{state.creating?label('Preparing…','正在准备…'):label('Start Little X','开始使用小 X')}</button>{!state.ready&&<p role="status">{label('Loading Host…','正在连接 Host…')}</p>}</div>}
    {state.exists&&!state.active&&<button type="button" onClick={()=>service.open()}>{label('Open Little X','打开小 X 对话')}</button>}
  </section>
}
interface AssistantContext extends Pick<ClientContext,'effect'|'slots'> {get(name:'sessions'):AssistantSessions;get(name:'workspaces'):Pick<IWorkspaces,'list'>;get(name:'conversation'):AssistantConversation}
export const inject=['slots','sessions','workspaces','conversation']
export function apply(ctx:AssistantContext):void {
  const service=new GlobalAssistant(ctx.get('sessions'),ctx.get('workspaces'),ctx.get('conversation'))
  ctx.effect(()=>{const listener=(event:Event):void=>{const value:unknown=event instanceof CustomEvent?event.detail:undefined;const ref=assistantReference(value);if(value!=null&&!ref)return;service.request(ref??undefined)};window.addEventListener(ASSISTANT_OPEN,listener);return()=>{window.removeEventListener(ASSISTANT_OPEN,listener);service.dispose()}},'assistant: explicit navigation and lifecycle')
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.xharnessAssistant='';style.textContent=CSS;document.head.append(style);return()=>style.remove()},'assistant: scoped styles')
  ctx.slots.inject('sidebar.primary.action',()=>ctx.slots.register({name:'sidebar.primary.action',id:'global-assistant',inject:()=>({})},AssistantNavigation))
  ctx.slots.inject('assistant.center',()=>ctx.slots.register({name:'assistant.center',id:'global-assistant',inject:()=>({service})},AssistantCenter))
}
