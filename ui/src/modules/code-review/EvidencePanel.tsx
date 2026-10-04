import {useEffect,useState} from 'react'
import {MarkdownText} from '@xharness/dsh-client-ui-primitives'
import {RequestLane} from './data'
import type {GitHubClient,PullDetail,ReviewThread,WorkflowRun,WorkflowJob,CursorPage,JobLog} from './client'
export interface DiffLocation {path:string;side:'left'|'right';line:number}
interface EvidenceProps {client:GitHubClient;account:string;record:PullDetail;zh:boolean;jump(location:DiffLocation):void}
const err=(e:unknown):string=>e instanceof Error?e.message:'GitHub request failed'
function Thread({thread,client,account,record,zh,jump}:EvidenceProps&{thread:ReviewThread}){
 const [open,setOpen]=useState(false),[comments,setComments]=useState(thread.comments),[busy,setBusy]=useState(false),[error,setError]=useState(''),[lane]=useState(()=>new RequestLane())
 useEffect(()=>()=>lane.cancel(),[lane])
 async function more(){const req=lane.start();setBusy(true);setError('');try{const page=await client.threadComments(account,record,thread.id,comments.cursor,req.signal);if(req.current())setComments(old=>({...page,items:[...old.items,...page.items.filter(n=>!old.items.some(o=>o.id===n.id))]}))}catch(e:unknown){if(req.current())setError(err(e))}finally{if(req.current())setBusy(false)}}
 return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)} className="xhreview-thread"><summary>{thread.path}:{thread.line??'—'} · {thread.outdated?(zh?'已过期':'Outdated'):thread.resolved?(zh?'已解决':'Resolved'):(zh?'未解决':'Unresolved')}</summary>
 {open&&<>{!thread.outdated&&thread.line!==null&&<button onClick={()=>jump({path:thread.path,side:thread.side,line:thread.line??1})}>{zh?'定位代码':'Show code'}</button>}
 {comments.items.map(c=><article key={c.id} className="xhreview-comment"><strong>{c.author}</strong><MarkdownText text={c.body}/></article>)}
 {comments.hasMore&&<button disabled={busy} onClick={()=>void more()}>{zh?'更多回复':'More replies'}</button>}{error&&<p role="alert">{error}</p>}</>}</details>
}
function Jobs({run,client,account,record,zh}:Omit<EvidenceProps,'jump'>&{run:WorkflowRun}){
 const [jobs,setJobs]=useState<WorkflowJob[]>([]),[more,setMore]=useState(false),[page,setPage]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[logs,setLogs]=useState<readonly {job:number;value:JobLog}[]>([]),[openJobs,setOpenJobs]=useState<ReadonlySet<number>>(()=>new Set()),[lane]=useState(()=>new RequestLane())
 useEffect(()=>()=>lane.cancel(),[lane])
 async function read(job?:number){const req=lane.start();setBusy(true);setError('');try{
  if(job!==undefined){const result=await client.logs(account,record,run,job,req.signal);if(req.current())setLogs(old=>[...old.filter(item=>item.job!==job),{job,value:result}].slice(-3))}
  else {const result=await client.jobs(account,record,run,page+1,req.signal);if(req.current()){setJobs(old=>[...old,...result.items.filter(n=>!old.some(o=>o.id===n.id))]);setPage(old=>old+1);setMore(result.hasMore)}}
 }catch(e:unknown){if(req.current())setError(err(e))}finally{if(req.current())setBusy(false)}}
 return <details onToggle={e=>{if(e.currentTarget.open&&page===0&&!busy)void read()}} className="xhreview-workflow"><summary>{run.name} · {run.conclusion??run.status} · #{run.attempt}{run.mergeTest?` · ${zh?'合并测试提交':'merge-test commit'}`:''}</summary>
 {jobs.map(job=>{const log=logs.find(item=>item.job===job.id)?.value;return <details key={job.id} onToggle={event=>{const open=event.currentTarget.open;setOpenJobs(old=>{const next=new Set(old);if(open)next.add(job.id);else next.delete(job.id);return next})}}><summary>{job.name} · {job.conclusion??job.status}</summary>{openJobs.has(job.id)&&<><ol>{job.steps.map(step=><li key={step.number}>{step.name} · {step.conclusion??step.status}</li>)}</ol><button disabled={busy} onClick={()=>void read(job.id)}>{zh?'加载日志':'Load logs'}</button>{log&&<><pre className="xhreview-log">{log.text}</pre>{log.truncated&&<p role="status">{zh?'日志超过显示上限，内容不完整。':'Log exceeds the display bound; content is incomplete.'}</p>}</>}</>}</details>})}
 {busy&&<p role="status">{zh?'加载中…':'Loading…'}</p>}{error&&<p role="alert">{error}</p>}{more&&<button disabled={busy} onClick={()=>void read()}>{zh?'更多任务':'More jobs'}</button>}{page>0&&!jobs.length&&<p>{zh?'暂无任务':'No jobs'}</p>}</details>
}
export function EvidencePanel(props:EvidenceProps){
 const {client,account,record,zh}=props
 const [threads,setThreads]=useState<CursorPage<ReviewThread>|null>(null),[runs,setRuns]=useState<WorkflowRun[]>([]),[runMore,setRunMore]=useState(false),[runPage,setRunPage]=useState(0),[busy,setBusy]=useState(''),[error,setError]=useState(''),[lane]=useState(()=>new RequestLane())
 useEffect(()=>()=>lane.cancel(),[lane])
 async function read(kind:'threads'|'runs'){const req=lane.start();setBusy(kind);setError('');try{
  if(kind==='threads'){const result=await client.threads(account,record,threads?.cursor??null,req.signal);if(req.current())setThreads(old=>({...result,items:[...(old?.items??[]),...result.items.filter(n=>!old?.items.some(o=>o.id===n.id))]}))}
  else {const result=await client.runs(account,record,runPage+1,req.signal);if(req.current()){setRuns(old=>[...old,...result.items.filter(n=>!old.some(o=>o.id===n.id))]);setRunMore(result.hasMore);setRunPage(old=>old+1)}}
 }catch(e:unknown){if(req.current())setError(err(e))}finally{if(req.current())setBusy('')}}
 return <><section><h3>{zh?'行内讨论':'Inline discussions'}</h3>{threads?.items.map(thread=><Thread {...props} thread={thread} key={thread.id}/>)}{threads&&!threads.items.length&&<p>{zh?'暂无行内讨论':'No inline discussions'}</p>}{(!threads||threads.hasMore)&&<button disabled={!!busy} onClick={()=>void read('threads')}>{threads?(zh?'更多讨论':'More discussions'):(zh?'加载讨论':'Load discussions')}</button>}</section>
 <section><h3>Actions</h3>{runs.map(run=><Jobs key={run.id} {...props} run={run}/>)}{runPage>0&&!runs.length&&<p>{zh?'当前提交暂无运行记录':'No runs for this commit'}</p>}{(runPage===0||runMore)&&<button disabled={!!busy} onClick={()=>void read('runs')}>{runPage?(zh?'更多运行':'More runs'):(zh?'加载任务与步骤':'Load jobs and steps')}</button>}</section>{busy&&<p role="status">{zh?'加载中…':'Loading…'}</p>}{error&&<p role="alert" className="xhreview-error">{error}</p>}</>
}
