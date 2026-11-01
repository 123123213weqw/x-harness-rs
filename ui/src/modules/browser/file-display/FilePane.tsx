import {useEffect,useMemo,useRef,useState} from 'react'
import type {ReactNode} from 'react'
import {MarkdownText,CodeBlock,writeClipboard} from '@xharness/dsh-client-ui-primitives'
import {GitDiffScopeSchema} from '../../shared/generated/file-display'
import {fileType,formatFileSize} from '../../shared/file-types'
import type {DisplayInspection} from '../../shared/file-inspection'
import type {DisplayFile,GitDiffScope} from '../../shared/generated/file-display'
import type {WorkspaceItemOwner} from '../../layout/workspace-pane'
import {DiffPreview} from './DiffPreview'
import {FileDisplayClient,ResourceBudget,localResource,imageObjectUrl,pdfObjectUrl,codeLanguage,isHtmlPath,staticHtmlDocument} from './client'
export function openDisplayFile(path:string,sessionId:string,relativeTo?:string,gitDiff?:GitDiffScope):void{
  window.dispatchEvent(new CustomEvent('xharness:workspace-open',{detail:{kind:'file',source:path,sessionId,...gitDiff===undefined?{}:{gitDiff},...gitDiff===undefined?{}:{title:label('差异 · ','Diff · ')+gitDiff},...relativeTo===undefined?{}:{relativeTo}}}))
}
type ImageState={kind:'image';path:string;url:string;width:number;height:number}
type PdfState={kind:'pdf';path:string;url:string}
type InfoState={kind:'info';path:string;metadata?:DisplayInspection|undefined}
type FileState=Exclude<DisplayFile,{kind:'image'|'pdf'}>|ImageState|PdfState|InfoState
const zh=()=>document.documentElement.lang.toLowerCase().startsWith('zh')
const label=(cn:string,en:string)=>zh()?cn:en
function LocalImage({path,alt,base,sessionId,client,budget}:{path:string;alt:string;base:string;sessionId:string;client:FileDisplayClient;budget:ResourceBudget}){
  const ref=useRef<HTMLSpanElement>(null),[src,setSrc]=useState<string>(),[error,setError]=useState('')
  useEffect(()=>{
    const element=ref.current;if(!element)return
    const controller=new AbortController();let url:string|undefined,started=false
    const load=()=>{
      if(started)return;started=true
      if(!budget.admit()){setError(label('图片数量超过预览预算，点击单独查看','Image preview budget reached; open individually'));return}
      void client.read(sessionId,path,controller.signal,base).then(file=>{
        if(controller.signal.aborted)return
        if(file.kind!=='image')throw new Error(label('不是可预览的图片','Not a previewable image'))
        const created=imageObjectUrl(file)
        if(!budget.retain(created.bytes,file.width*file.height*4)){URL.revokeObjectURL(created.url);throw new Error(label('图片超过预览预算','Image preview budget reached'))}
        url=created.url;setSrc(url)
      }).catch((e:unknown)=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:String(e))})
    }
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();load()}},{rootMargin:'200px'})
    observer.observe(element)
    return()=>{controller.abort();observer.disconnect();if(url)URL.revokeObjectURL(url)}
  },[path,base,sessionId,client,budget])
  return <span ref={ref} className="xhfile-local-image">{src?<img src={src} alt={alt} decoding="async"/>:<span>{error||alt||label('加载图片…','Loading image…')}</span>}{error&&<button type="button" onClick={()=>openDisplayFile(path,sessionId,base)}>{label('单独查看','Open separately')}</button>}</span>
}
function MarkdownFile({file,sessionId,client}:{file:Extract<DisplayFile,{kind:'markdown'}>;sessionId:string;client:FileDisplayClient}){
  const resources=useMemo(()=>{
    const budget=new ResourceBudget()
    return {
      image:(url:string,alt:string):ReactNode|undefined=>{const path=localResource(url);return path===undefined?undefined:<LocalImage path={path} alt={alt} base={file.path} sessionId={sessionId} client={client} budget={budget}/>},
      link:(url:string,children:ReactNode):ReactNode|undefined=>{const path=localResource(url);return path===undefined?undefined:<button type="button" className="xhfile-link" onClick={()=>openDisplayFile(path,sessionId,file.path)}>{children}</button>},
    }
  },[file.path,sessionId,client])
  return <MarkdownText text={file.text} resources={resources}/>
}
export function FilePane({item,open,sessionId,client}:WorkspaceItemOwner&{client:FileDisplayClient}){
  const owner=item.sessionId??sessionId
  const actionGeneration=useRef(0)
  const [actionError,setActionError]=useState(''),[nativeBusy,setNativeBusy]=useState(false),[copied,setCopied]=useState(false)
  useEffect(()=>{if(!copied)return;const timer=window.setTimeout(()=>setCopied(false),1800);return()=>window.clearTimeout(timer)},[copied])
  const [file,setFile]=useState<FileState>(),[error,setError]=useState(''),[revision,setRevision]=useState(0),[source,setSource]=useState(false),[zoom,setZoom]=useState(0)
  useEffect(()=>{
    actionGeneration.current++;setNativeBusy(false)
    setFile(undefined);setError('');setActionError('');setCopied(false);setZoom(0);setSource(false)
    if(!owner)return
    const controller=new AbortController();let objectUrl:string|undefined
    void (async()=>{
      if(!item.gitDiff){
        const metadata=await client.inspect(owner,item.source,controller.signal,item.relativeTo,revision).catch(()=>undefined)
        if(controller.signal.aborted)return undefined
        if(metadata?['unsupported','tooLarge'].includes(metadata.preview):fileType(item.source).preview==='none')return {kind:'info',path:metadata?.path??item.source,metadata} satisfies InfoState
      }
      return client.read(owner,item.source,controller.signal,item.relativeTo,item.gitDiff)
    })().then(result=>{
      if(controller.signal.aborted||!result)return
      if(result.kind==='image'){objectUrl=imageObjectUrl(result).url;setFile({kind:'image',path:result.path,url:objectUrl,width:result.width,height:result.height})}
      else if(result.kind==='pdf'){objectUrl=pdfObjectUrl(result);setFile({kind:'pdf',path:result.path,url:objectUrl})}
      else setFile(result)
    }).catch((e:unknown)=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:String(e))})
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)}
  },[owner,item.source,item.relativeTo,item.gitDiff,revision,client])
  const path=file?.path??item.source
  const html=useMemo(()=>file?.kind==='text'&&isHtmlPath(file.path)?staticHtmlDocument(file.text):undefined,[file])
  const nativeAction=async(mode:'open'|'reveal'):Promise<void>=>{
    const generation=actionGeneration.current
    setNativeBusy(true);setActionError('')
    try{if(mode==='reveal')await client.reveal(path);else await client.openExternal(path)}
    catch(error:unknown){if(generation===actionGeneration.current)setActionError(error instanceof Error?error.message:String(error))}
    finally{if(generation===actionGeneration.current)setNativeBusy(false)}
  }
  return <section className="xhfile-pane" data-file-page-state={open?'visible':'retained'} aria-label={label('文件预览','File preview')}>
    <header className="xhfile-toolbar">
      <span className="xhfile-path" title={path}>{path}</span>
      {!item.gitDiff&&client.canReveal(path)&&<button type="button" disabled={nativeBusy} onClick={()=>{void nativeAction('reveal')}}>{label('在文件夹中显示','Show in folder')}</button>}
      {!item.gitDiff&&client.canOpenExternal(path)&&<button type="button" disabled={nativeBusy} onClick={()=>{void nativeAction('open')}}>{label('默认应用打开','Open with default app')}</button>}
      <button type="button" onClick={()=>{void writeClipboard(path).then(ok=>{setCopied(ok);setActionError(ok?'':label('路径复制失败','Could not copy path'))})}}>{copied?label('路径已复制','Path copied'):label('复制路径','Copy path')}</button>
      <button type="button" onClick={()=>setRevision(value=>value+1)} aria-label={label('刷新文件','Refresh file')}>↻</button>
      {item.gitDiff&&<select aria-label={label('差异范围','Diff scope')} value={item.gitDiff} onChange={event=>{const scope=GitDiffScopeSchema.safeParse(event.target.value);if(scope.success&&owner)openDisplayFile(item.source,owner,undefined,scope.data)}}><option value="working">{label('未暂存','Unstaged')}</option><option value="staged">{label('已暂存','Staged')}</option><option value="head">{label('相对 HEAD','Against HEAD')}</option></select>}
      {(file?.kind==='markdown'||html!==undefined)&&<button type="button" aria-pressed={source} onClick={()=>setSource(value=>!value)}>{source?label('预览','Preview'):label('源码','Source')}</button>}
      {file?.kind==='image'&&<><button type="button" onClick={()=>setZoom(value=>Math.max(25,(value||100)-25))} aria-label={label('缩小','Zoom out')}>−</button><button type="button" onClick={()=>setZoom(0)}>{zoom?`${zoom}%`:label('适应','Fit')}</button><button type="button" onClick={()=>setZoom(value=>Math.min(400,(value||100)+25))} aria-label={label('放大','Zoom in')}>+</button></>}
    </header>
    {actionError&&<p className="xhfile-action-error" role="alert">{actionError}</p>}
    <div className="xhfile-body" data-diff={file?.kind==='diff'||undefined} data-document={file?.kind==='pdf'||html!==undefined&&!source||undefined} key={revision}>
      {!owner?<p role="alert">{label('请选择一个会话后打开文件','Select a conversation before opening files')}</p>
        :error?<div role="alert"><p>{label('此文件暂时无法内置预览，可以在文件夹中查看或使用默认应用打开。','This file cannot be previewed here. Show it in its folder or open with the default app.')}</p><details><summary>{label('详情','Details')}</summary><p>{error}</p></details><button type="button" onClick={()=>setRevision(value=>value+1)}>{label('重试','Retry')}</button></div>
        :!file?<p role="status">{label('加载文件…','Loading file…')}</p>
        :file.kind==='info'?<div className="xhfile-info"><p>{file.metadata?.preview==='tooLarge'?label('文件超过内置预览大小限制。','Too large for built-in preview.'):label('此格式暂不支持内置预览。','This format has no built-in preview.')}</p><p>{file.metadata?formatFileSize(file.metadata.bytes):''}</p><p>{label('可以使用顶部的打开选项，或复制路径。','Use the opening options above, or copy the path.')}</p></div>
        :file.kind==='image'?<div className="xhfile-image"><img src={file.url} alt={file.path.split(/[\\/]/).at(-1)} style={zoom?{width:`${file.width*zoom/100}px`,maxWidth:'none'}:undefined} decoding="async"/><small>{file.width} × {file.height}</small></div>
        :file.kind==='pdf'?<><p className="xhfile-preview-note">{label('PDF 预览 · 如无法显示，请使用默认应用打开','PDF preview · If unavailable, use the default app')}</p><iframe className="xhfile-document" title={label('PDF 预览','PDF preview')} src={file.url} referrerPolicy="no-referrer"/></>
        :file.kind==='diff'?<DiffPreview file={file}/>
        :file.kind==='markdown'&&!source?<MarkdownFile file={file} sessionId={owner} client={client}/>
        :html!==undefined&&!source?<><p className="xhfile-preview-note">{label('静态预览 · 不执行脚本或加载外部资源','Static preview · Scripts and external resources are disabled')}</p><iframe className="xhfile-document" title={label('HTML 预览','HTML preview')} sandbox="" srcDoc={html} referrerPolicy="no-referrer"/></>
        :<CodeBlock code={file.text} lang={file.kind==='markdown'?'markdown':codeLanguage(file.path)}/>}
    </div>
  </section>
}
