import * as React from 'react'
import CSS from './RunPanel.css'
import {installStyles} from '../views-types'
installStyles('@xharness/jobs/RunPanel.css','@xharness/jobs',CSS)
import type {JobClient} from './client'
import {processHint,type JobRun} from './model'
import type {IWorkCatalog} from '../client-runtime/index'
const zh=()=>typeof document!=='undefined'&&document.documentElement.lang.startsWith('zh')
const labels:Readonly<Record<string,readonly string[]>>={preparing:['准备中','Preparing'],queued:['排队中','Queued'],running:['运行中','Running'],waiting:['等待中','Waiting'],stopping:['停止中','Stopping'],completed:['已完成','Completed'],failed:['失败','Failed'],cancelled:['已取消','Cancelled'],interrupted:['已中断','Interrupted'],incomplete:['未完成','Incomplete'],unavailable:['不可用','Unavailable'],scheduled:['等待触发','Scheduled'],overdue:['等待调度','Overdue'],paused:['未来触发已暂停','Future triggers paused'],finished:['触发已结束','Trigger finished'],deleted:['未来触发已取消','Future triggers cancelled'],inherited:['继承记录','Inherited'],inactive:['未启用','Inactive']}
const label=(state:string)=>labels[state]?.[zh()?0:1]??state
function RunRow({run,client,openSession}:{run:JobRun;client:JobClient;openSession?:((id:string)=>void)|undefined}) {
  const [pending,setPending]=React.useState(false),[error,setError]=React.useState(''),[output,setOutput]=React.useState('')
  const controller=React.useRef<AbortController>(), alive=React.useRef(true),mutation=React.useRef(false)
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort()}},[run.id,run.sourceSessionId])
  async function act(kind:'output'|'cancel') {
    if(mutation.current)return
    mutation.current=true;setPending(true);setError('');controller.current?.abort();controller.current=new AbortController()
    try {if(kind==='cancel')await client.control(run.sourceSessionId,{action:'cancel_run',reference:run.reference})
      else {const value=await client.output(run.sourceSessionId,run.reference,controller.current.signal);if(alive.current)setOutput(`${value.stdout}${value.stderr ? `\n${value.stderr}`:''}${value.stdoutTruncated||value.stderrTruncated?`\n${zh()?'[较早输出已被清理]':'[Earlier output was evicted]'}`:''}`)}}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}
    finally {mutation.current=false;if(alive.current)setPending(false)}
  }
  return <article className="xhjob-run" data-run-id={run.id} data-run-state={run.state}>
    <div className="xhauto-card-title">{run.label}</div>
    <div className="xhauto-card-bottom"><span>{run.reference.kind==='process'?(zh()?'命令':'Command'):(zh()?'Agent':'Agent')} · {label(run.state)}</span>
      <div className="xhauto-card-actions">{run.capabilities.readOutput&&<button disabled={pending} onClick={()=>void act('output')}>{zh()?'读取输出':'Read output'}</button>}
        {run.capabilities.cancelRun&&<button disabled={pending} onClick={()=>void act('cancel')}>{zh()?'取消本次执行':'Cancel this run'}</button>}
        {run.capabilities.openSession&&openSession&&<button onClick={()=>openSession(run.targetSessionId)}>{zh()?'查看对话':'Open conversation'}</button>}</div></div>
    <details><summary>{zh()?'运行详情':'Run details'}</summary><div className="xhauto-card-muted"><code>{run.id}</code>{run.startedAtMs!==null&&<> · {zh()?'开始':'Started'} {new Date(run.startedAtMs).toLocaleString()}</>}</div></details>
    {run.detail&&<div className="xhauto-card-muted">{run.detail}</div>}{output&&<pre aria-label={zh()?'运行输出':'Run output'}>{output}</pre>}{error&&<div className="xhauto-card-error" role="alert">{error}</div>}
  </article>
}
export function JobRunPanel({client,sessionId,planId,runId,openSession}:{client:JobClient;sessionId:string;planId?:string|undefined;runId?:string|undefined;openSession?:((id:string)=>void)|undefined}) {
  const subscribe=React.useCallback((f:()=>void)=>client.subscribe(sessionId,f),[client,sessionId]),snapshot=React.useCallback(()=>client.snapshot(sessionId),[client,sessionId])
  const state=React.useSyncExternalStore(subscribe,snapshot)
  const [pending,setPending]=React.useState(false),[error,setError]=React.useState(''),[confirm,setConfirm]=React.useState<string>()
  const gate=React.useRef(false),alive=React.useRef(true)
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[sessionId,planId])
  async function control(id:string,action:'pause_plan'|'resume_plan'|'cancel_future') {
    if(gate.current)return;gate.current=true;setPending(true);setError('')
    try {await client.control(sessionId,{action,planId:id});if(alive.current)setConfirm(undefined)}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}finally{gate.current=false;if(alive.current)setPending(false)}
  }
  const plans=runId===undefined ? state.catalog?.plans.filter(p=>planId===undefined||p.id===planId)??[] : [],runs=state.catalog?.runs.filter(r=>(planId===undefined||r.planId===planId)&&(runId===undefined||r.id===runId))??[]
  return <section className="xhauto-card xhjob-panel" aria-label={zh()?'执行记录':'Execution records'}>
    <header><span>{zh()?'执行记录':'Execution records'}</span><button disabled={state.loading} onClick={()=>void client.refresh(sessionId)}>{zh()?'刷新':'Refresh'}</button></header>
    {state.loading&&!state.catalog&&<p role="status">{zh()?'读取中…':'Loading…'}</p>}{(state.error||error)&&<p className="xhauto-card-error" role="alert">{state.error??error}</p>}
    {!state.error&&plans.map(p=><div key={p.id} className="xhjob-plan"><div className="xhauto-card-title">{p.label}</div><div className="xhauto-card-bottom"><span>{zh()?'计划':'Plan'} · {label(p.state)}</span>
      {['scheduled','overdue','paused'].includes(p.state)&&<div className="xhauto-card-actions"><button disabled={pending} onClick={()=>void control(p.id,p.state==='paused'?'resume_plan':'pause_plan')}>{p.state==='paused'?(zh()?'恢复未来触发':'Resume future triggers'):(zh()?'暂停未来触发':'Pause future triggers')}</button>
        {confirm===p.id?<><span>{zh()?'取消后不再触发，正在运行的任务不受影响。':'Stop future triggers, without cancelling admitted runs?'}</span><button disabled={pending} onClick={()=>void control(p.id,'cancel_future')}>{zh()?'确认':'Confirm'}</button><button onClick={()=>setConfirm(undefined)}>{zh()?'返回':'Back'}</button></>:<button disabled={pending} onClick={()=>setConfirm(p.id)}>{zh()?'取消未来触发':'Cancel future triggers'}</button>}</div>}</div></div>)}
    {!state.error&&runs.map(run=><RunRow key={JSON.stringify([sessionId,run.id])} run={run} client={client} openSession={openSession}/>)}
    {state.catalog&&!state.error&&runs.length===0&&<p className="xhauto-card-muted">{runId?(zh()?'此运行已失效或已被清理；不会关联到新的同名任务。':'This run expired or was evicted; it will not resolve to another job.'):(zh()?'暂无执行记录。等待触发不代表执行成功。':'No runs yet. A scheduled trigger is not execution success.')}</p>}
  </section>
}
export function JobToolPanel({client,sessionId,block}:{client:JobClient;sessionId:string;block:unknown}) {
  const id=processHint(block)
  return id?<JobRunPanel client={client} sessionId={sessionId} runId={id}/>:null
}
export function ExecutionsPage({client,service,openSession}:{client:JobClient;service:IWorkCatalog;openSession:(id:string)=>void}) {
  const snapshot=React.useSyncExternalStore(service.subscribe,service.getSnapshot),[selected,setSelected]=React.useState('')
  const sessions=snapshot.sessions
  const current=sessions.some(s=>s.sessionId===selected)?selected:sessions[0]?.sessionId
  React.useEffect(()=>{const c=new AbortController();void service.refresh(c.signal).catch(()=>{});return()=>c.abort()},[service])
  return <section className="xhauto-page"><h2>{zh()?'任务执行':'Executions'}</h2>{snapshot.error&&<p role="alert">{snapshot.error}</p>}
    <label>{zh()?'对话':'Chat'} <select aria-label={zh()?'执行记录所属对话':'Execution chat'} value={current??''} onChange={e=>setSelected(e.target.value)}>{sessions.map(s=><option key={s.sessionId} value={s.sessionId}>{s.sessionId}</option>)}</select></label>
    {current?<JobRunPanel key={current} client={client} sessionId={current} openSession={openSession}/>:snapshot.loading||snapshot.phase==='pending'?<p role="status">{zh()?'读取对话中…':'Loading chats…'}</p>:<p>{zh()?'暂无对话':'No chats'}</p>}</section>
}
