import {useEffect,useState} from 'react'
import {MarkdownText} from '@xharness/dsh-client-ui-primitives'
import type {GitHubClient,PullDetail,ReviewModel,ReviewRun} from './client'
import type {DiffLocation} from './EvidencePanel'
import {RequestLane} from './data'
import {decodeReviewReport} from './structured'
import type {ReviewReport} from './structured'
interface Props {client:GitHubClient;account:string;record:PullDetail;zh:boolean;disabled:boolean;jump(location:DiffLocation):void;reference?:((location:DiffLocation)=>void)|undefined}
const message=(e:unknown):string=>e instanceof Error?e.message:'Review request failed'
function Findings({run,zh,jump,stale,reference}:{run:ReviewRun;zh:boolean;stale:boolean;jump(location:DiffLocation):void;reference?:((location:DiffLocation)=>void)|undefined}){
 let report:ReviewReport
 try{report=decodeReviewReport(run.text,run.snapshot)}catch(e:unknown){return <p role="alert">{message(e)}</p>}
 return <div className="xhreview-findings"><p className="xhreview-muted">{zh?'AI 发现 · 待确认':'AI findings · Needs confirmation'} · {report.suppliedFiles.length}/{run.snapshot.changedFiles} {zh?'个文件':'files'}</p>
 {report.scopeIncomplete&&<p role="status">{zh?'审核范围不完整，部分文件或 Diff 未提供。':'Review scope is incomplete; some files or diffs were not supplied.'}</p>}
 {report.findings.map(f=><article key={f.id} className="xhreview-finding"><h3><span>P{f.priority}</span> {f.title}</h3><button disabled={stale} onClick={()=>jump({path:f.path,side:f.side,line:f.startLine})}>{f.path}:{f.startLine}{f.endLine!==f.startLine?`–${f.endLine}`:''} · {f.side}</button><p>{f.explanation}</p>{reference&&<button disabled={stale} onClick={()=>reference({path:f.path,side:f.side,line:f.startLine})}>{zh?'交给小 X':'Ask Little X'}</button>}<details><summary>{zh?'代码证据':'Code evidence'}</summary><pre>{f.evidence}</pre></details></article>)}
 {!report.findings.length&&<p role="status">{report.outcome==='invalid-findings'?(zh?'模型发现均未通过证据校验，不能作为无问题结论。':'All findings failed evidence validation; this is not a clean result.'):(zh?'所提供范围内未发现问题，不代表审核通过。':'No findings in the supplied scope; this is not approval.')}</p>}
 {!!report.rejected.length&&<details><summary>{report.rejected.length} {zh?'项未通过校验':'rejected findings'}</summary><ul>{report.rejected.map(f=><li key={f.index}>#{f.index+1}: {f.reason}</li>)}</ul></details>}</div>
}
export function ReviewPanel({client,account,record,zh,disabled,jump,reference}:Props){
 const [models,setModels]=useState<ReviewModel[]>([]),[choice,setChoice]=useState(''),[runs,setRuns]=useState<ReviewRun[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [lane]=useState(()=>new RequestLane()),[poll]=useState(()=>new RequestLane()),[modelLane]=useState(()=>new RequestLane())
 useEffect(()=>{const req=modelLane.start();void client.reviewModels(req.signal).then(items=>{if(req.current()){setModels(items);setChoice(items[0]?JSON.stringify([items[0].provider,items[0].model]):'')}}).catch((e:unknown)=>{if(req.current())setError(message(e))});return()=>modelLane.cancel()},[client,modelLane])
 useEffect(()=>{const req=lane.start();setBusy(false);setError('');void client.reviewHistory(account,record,req.signal).then(items=>{if(req.current()){setRuns(items);setSelected(items[0]?.id??'')}}).catch((e:unknown)=>{if(req.current())setError(message(e))});return()=>{lane.cancel();poll.cancel()}},[client,account,record.headSha,lane,poll])
 const current=runs.find(run=>run.id===selected),active=runs.find(run=>run.status==='running')
 useEffect(()=>{if(!active)return;const req=poll.start();let timer:ReturnType<typeof setTimeout>|undefined
  async function read(){try{if(!active)return;const result=await client.reviewStatus(active,'status',req.signal);if(!req.current())return;setRuns(old=>old.map(r=>r.id===result.id?result:r));if(result.status==='running')timer=setTimeout(()=>void read(),1500)}catch(e:unknown){if(req.current()){setError(message(e));timer=setTimeout(()=>void read(),5000)}}}
  timer=setTimeout(()=>void read(),1000);return()=>{if(timer!==undefined)clearTimeout(timer);poll.cancel()}
 },[client,active?.id,poll])
 function save(run:ReviewRun){setRuns(old=>[run,...old.filter(r=>r.id!==run.id)].slice(0,30));setSelected(run.id)}
 async function start(){const model=models.find(m=>JSON.stringify([m.provider,m.model])===choice);if(!model)return;const req=lane.start();setBusy(true);setError('');try{const run=await client.startReview(account,record,model,'review','',req.signal);if(req.current()){save(run)}}catch(e:unknown){if(req.current())setError(message(e))}finally{if(req.current())setBusy(false)}}
 async function cancel(){if(!active)return;const req=lane.start();setBusy(true);setError('');try{const run=await client.reviewStatus(active,'cancel',req.signal);if(req.current())save(run)}catch(e:unknown){if(req.current())setError(message(e))}finally{if(req.current())setBusy(false)}}
 const stale=current&&(current.stale||current.target.sha!==record.headSha)
 return <section className="xhreview-model" aria-label={zh?'模型审核':'Model review'}><header><h3>{zh?'模型审核':'Model review'}</h3><span className="xhreview-sha">{record.headSha.slice(0,8)}</span></header>
 {runs.length>0&&<label>{zh?'审核记录':'Review history'} <select aria-label={zh?'审核记录':'Review history'} value={selected} onChange={e=>setSelected(e.target.value)}>{runs.map(r=><option key={r.id} value={r.id}>{r.model} · {r.target.sha.slice(0,8)} · {r.status} · {r.mode}</option>)}</select></label>}
 {current&&<article className="xhreview-model-result"><p>{current.model} · {current.status} · {current.target.sha.slice(0,8)}</p>{stale&&<p role="status" className="xhreview-error">{zh?'此结果已过期或当前提交无法确认，请重新审核。':'This result is stale or current head could not be verified. Review again.'}</p>}{current.question&&<blockquote>{current.question}</blockquote>}
 {current.status==='running'?<><p role="status">{zh?'正在审核…':'Reviewing…'} · {current.text.length} {zh?'字符已接收':'characters received'}</p>{current.mode==='question'&&<MarkdownText text={current.text}/>}</>:current.status==='completed'?(current.mode==='review'?<Findings run={current} zh={zh} stale={!!stale} jump={jump} reference={reference}/>:<MarkdownText text={current.text}/>):<><p role="alert">{current.error??current.status}</p>{current.text&&<details><summary>{zh?'未完成输出':'Incomplete output'}</summary><pre>{current.text}</pre></details>}</>}
 </article>}
 {!runs.length&&<p className="xhreview-muted">{zh?'选择模型审核当前变更，或交给全局助手讨论。':'Select a model to review these changes, or discuss them with the assistant.'}</p>}
 {busy&&<p role="status">{zh?'正在准备请求…':'Preparing request…'}</p>}{error&&<p role="alert" className="xhreview-error">{error}</p>}
 <div className="xhreview-composer"><label>{zh?'模型':'Model'} <select aria-label={zh?'审核模型':'Review model'} value={choice} onChange={e=>setChoice(e.target.value)} disabled={busy||!!active}>{models.map(m=><option key={JSON.stringify([m.provider,m.model])} value={JSON.stringify([m.provider,m.model])}>{m.name} · {m.provider}</option>)}</select></label>
 {!models.length&&<p role="status">{zh?'没有可用模型，请先配置 provider。':'No available models. Configure a provider first.'}</p>}
 <div><button disabled={disabled||busy||!!active||!choice} onClick={()=>void start()}>{zh?'审核变更':'Review changes'}</button>{active&&<button disabled={busy} onClick={()=>void cancel()}>{zh?'停止':'Stop'}</button>}</div></div></section>
}
