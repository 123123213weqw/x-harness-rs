import {useState, useRef, useEffect} from 'react'
import type {ImportProps, ImportReport} from './contracts'
import {errorText} from '../shared/runtime-types'
const MAX_BYTES=8*1024*1024
/** File choice and preview never create a session; only the explicit Import click does. */
export function ImportSettings({api,sessions,t,close}: ImportProps) {
  const [source,setSource]=useState<'claude-code'|'codex'>('claude-code')
  const [jsonl,setJsonl]=useState(''), [name,setName]=useState(''), [cwd,setCwd]=useState('')
  const [report,setReport]=useState<ImportReport|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState(false)
  const revision=useRef(0), request=useRef<AbortController|null>(null)
  useEffect(()=>()=>{revision.current++;request.current?.abort()},[])
  function reset(){revision.current++;request.current?.abort();setReport(null);setError('');setJsonl('');setName('');setBusy(false)}
  async function choose(file: File|null){
    reset();if(!file)return
    if(!file.name.endsWith('.jsonl')||file.size>MAX_BYTES){setError(t('fileError'));return}
    const version=revision.current;const controller=new AbortController();request.current=controller;setBusy(true);setName(file.name)
    try {
      const text=await file.text();if(version!==revision.current)return
      setJsonl(text)
      const {result}=await api.sessions.importHistory({source,jsonl:text,preview:true},controller.signal)
      if(version!==revision.current)return
      if(!result.ok)throw result.error
      setReport(result.value)
    }catch(e){if(version===revision.current)setError(errorText(e))}
    finally{if(version===revision.current)setBusy(false)}
  }
  async function retryPreview(){
    if(busy||!jsonl)return
    const version=revision.current;const controller=new AbortController();request.current=controller
    setBusy(true);setError('')
    try{const {result}=await api.sessions.importHistory({source,jsonl,preview:true},controller.signal);if(version!==revision.current)return;if(!result.ok)throw result.error;setReport(result.value)}
    catch(e){if(version===revision.current)setError(errorText(e))}finally{if(version===revision.current)setBusy(false)}
  }
  async function commit(){
    if(!report||busy||!jsonl)return
    setBusy(true);setError('');const version=revision.current;const controller=new AbortController();request.current=controller
    try {
      const {result}=await api.sessions.importHistory({source,jsonl,preview:false,...(cwd.trim()?{cwd:cwd.trim()}:{})},controller.signal)
      if(version!==revision.current)return
      if(!result.ok)throw result.error
      if(!result.value.sessionId)throw Error(t('missingSession'))
      await sessions.refresh();sessions.open(result.value.sessionId);close()
    }catch(e){if(version===revision.current)setError(errorText(e))}
    finally{if(version===revision.current)setBusy(false)}
  }
  return <section className="xhsi-root">
    <h2>{t('title')}</h2><p>{t('description')}</p>
    <label>{t('source')}<select value={source} disabled={busy} onChange={e=>{reset();setSource(e.currentTarget.value==='codex'?'codex':'claude-code')}}><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></label>
    <label>{t('file')}<input key={source} type="file" accept=".jsonl" disabled={busy} onChange={e=>{void choose(e.currentTarget.files?.item(0)??null)}} /></label>
    <small>{source==='codex'?'~/.codex/sessions/ · ~/.codex/archived_sessions/':'~/.claude/projects/'} — {t('fileHelp')}</small>
    <label>{t('destination')}<input value={cwd} disabled={busy} placeholder={t('defaultCwd')} onChange={e=>setCwd(e.currentTarget.value)} /></label>
    <small>{t('destinationHelp')}</small>
    {busy&&<p role="status">{t('working')}</p>}
    {error&&<p role="alert" className="xhsi-error">{error}</p>}
    {error&&jsonl&&!report&&<button type="button" disabled={busy} onClick={()=>{void retryPreview()}}>{t('retry')}</button>}
    {report&&<div className="xhsi-preview"><strong>{report.title}</strong><p>{name} · {t('counts',{messages:report.messages,tools:report.tools})}</p>
      {report.warnings.map(w=><p key={w} className="xhsi-warning">{t('warning.'+w)}</p>)}
      <details><summary>{t('preview')}</summary>{report.preview.map((m,i)=><pre key={i}>{m.role}: {m.content}</pre>)}</details>
    </div>}
    <p className="xhsi-note">{t('safety')}</p>
    <button type="button" className="xhsi-submit" disabled={busy||!report} onClick={()=>{void commit()}}>{t('import')}</button>
  </section>
}
