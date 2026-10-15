import {useEffect,useMemo,useRef,useState} from 'react'
import type {DisplayFile} from '../../shared/generated/file-display'
import {inspectPatch,splitRows} from './diff'
import type {DiffRow,SplitDiffRow} from './diff'
const zh=()=>document.documentElement.lang.toLowerCase().startsWith('zh')
const label=(cn:string,en:string)=>zh()?cn:en
const ROW_HEIGHT=22
function Cell({row,side}:{row?:DiffRow|undefined;side?:'left'|'right'|undefined}){
  return <span className="xhfile-diff-cell" data-kind={row?.kind??'empty'}><span className="xhfile-diff-num">{side==='left'?row?.left:row?.right}</span>{!side&&<span className="xhfile-diff-num">{row?.left}</span>}<span className="xhfile-diff-marker" aria-hidden>{row?.kind==='added'?'+':row?.kind==='removed'?'−':' '}</span><span>{row?.text??''}</span></span>
}
/** Fixed-height, non-wrapping rows; only the selected file and viewport mount. */
function Rows({rows,split}:{rows:readonly DiffRow[];split:boolean}){
  const ref=useRef<HTMLDivElement>(null),[viewport,setViewport]=useState({top:0,height:440})
  const halves=useMemo(()=>split?splitRows(rows):[],[rows,split])
  const count=split?halves.length:rows.length,start=Math.max(0,Math.floor(viewport.top/ROW_HEIGHT)-8),end=Math.min(count,Math.ceil((viewport.top+viewport.height)/ROW_HEIGHT)+8)
  const maxColumns=useMemo(()=>Math.min(16000,Math.max(12,...rows.filter(row=>row.kind!=='hunk'&&row.kind!=='note').map(row=>row.text.length))),[rows])
  useEffect(()=>{const element=ref.current;if(!element)return;const observer=new ResizeObserver(()=>setViewport(value=>({...value,height:element.clientHeight})));observer.observe(element);return()=>observer.disconnect()},[])
  return <div ref={ref} className="xhfile-diff-scroll" tabIndex={0} aria-label={label('差异内容','Diff content')} onScroll={event=>setViewport({top:event.currentTarget.scrollTop,height:event.currentTarget.clientHeight})}>
    <div className="xhfile-diff-lines" style={{minWidth:`${(maxColumns+(split?8:14))*(split?2:1)}ch`}}>
      <div style={{height:start*ROW_HEIGHT}} aria-hidden/>
      {Array.from({length:end-start},(_,offset)=>{const index=start+offset
        if(!split)return <div key={index} className="xhfile-diff-row" data-kind={rows[index]?.kind}><Cell row={rows[index]}/></div>
        const row:SplitDiffRow|undefined=halves[index]
        return <div key={index} className="xhfile-diff-row" data-split={!row?.full||undefined}>{row?.full?<Cell row={row.full}/>:<><Cell row={row?.left} side="left"/><Cell row={row?.right} side="right"/></>}</div>
      })}
      <div style={{height:(count-end)*ROW_HEIGHT}} aria-hidden/>
    </div>
  </div>
}
export function DiffPreview({file}:{file:Extract<DisplayFile,{kind:'diff'}>}){
  const parsed=useMemo(()=>inspectPatch(file.text),[file.text]),[selected,setSelected]=useState(0),[split,setSplit]=useState(false),[source,setSource]=useState(false)
  const current=parsed.files[selected]??parsed.files[0]
  const total=useMemo(()=>parsed.files.reduce((sum,item)=>({added:sum.added+item.added,removed:sum.removed+item.removed}),{added:0,removed:0}),[parsed.files])
  const scope=file.source==='patch'?label('补丁文件','Patch file'):file.source==='working'?label('未暂存 · 对比索引','Unstaged · against index'):file.source==='staged'?label('已暂存 · 对比 HEAD','Staged · against HEAD'):label('工作区 · 对比 HEAD','Worktree · against HEAD')
  return <section className="xhfile-diff" aria-label={label('差异预览','Diff preview')}>
    <header className="xhfile-diff-toolbar"><span>{scope}</span><span className="xhfile-diff-count">{parsed.files.length} {label('文件','files')} · <b>+{total.added}</b> <i>−{total.removed}</i></span><button type="button" aria-pressed={source} onClick={()=>setSource(value=>!value)}>{source?label('差异','Diff'):label('源码','Source')}</button><button type="button" aria-pressed={split} disabled={source||!!parsed.error||!current} onClick={()=>setSplit(value=>!value)}>{split?label('合并视图','Unified'):label('左右对照','Side by side')}</button></header>
    {file.source!=='patch'&&<p className="xhfile-diff-hint">{label('Git 范围包含用户已有修改，不代表仅本轮；不含未跟踪文件，子模块内部变更不展开。','Git scope includes pre-existing edits, not just this turn; excludes untracked files and submodule internals.')}</p>}
    {parsed.error&&<p role="alert">{label('无法解析差异：','Cannot parse diff: ')}{parsed.error}</p>}
    {source||parsed.error?<pre className="xhfile-diff-source">{file.text}</pre>:!current?<p role="status">{label('此范围没有差异','No differences in this scope')}</p>:<>
      <nav className="xhfile-diff-files" aria-label={label('变更文件','Changed files')}>{parsed.files.map((item,index)=><button type="button" key={index} aria-current={index===selected?'true':undefined} onClick={()=>setSelected(index)} title={item.path}><span>{item.oldPath?`${item.oldPath} → `:''}{item.path}</span><small>+{item.added} −{item.removed}</small></button>)}</nav>
      {current.binary?<p>{label('二进制文件变更，无文本差异','Binary file changed; no text diff')}</p>:!current.rows.length?<p>{current.rename?label('文件重命名','File renamed'):label('文件元数据变更','File metadata changed')}{current.mode&&` · ${current.mode}`}</p>:<Rows key={`${selected}:${split}`} rows={current.rows} split={split}/>}</>}
  </section>
}
