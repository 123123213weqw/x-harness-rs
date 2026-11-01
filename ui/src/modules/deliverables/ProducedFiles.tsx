// Evidence comes from successful mutation tools, never the assistant's prose.
import {useEffect,useId,useRef,useState} from 'react'
import type {ComponentType,KeyboardEvent,RefObject} from 'react'
import {Menu,writeClipboard,IconGlobeOutline14,IconCodeOutline16,IconDocumentOutline24,IconPresentationOutline24,IconSpreadsheetOutline24,IconPdfOutline24,IconPhotoOutline24,IconMovieOutline24,IconAudioOutline24,IconDatabaseOutline24,IconMarkdownOutline24,IconFileOutline24,IconArchiveOutline20,IconChevronDownOutline14,IconChevronUpOutline14} from '@xharness/dsh-client-ui-primitives'
import type {MenuEntry,IconProps} from '@xharness/dsh-client-ui-primitives'
import type {HostDescriptionSource,InjectFace,PropsLocale,TurnTailOwnerProps} from '../views-types'
import {fileName,fileType,parentPath,formatFileSize} from './file-kind'
import type {ProducedFileKind} from './file-kind'
import {thumbnailObjectUrl} from '../shared/file-inspection'
import type {DisplayInspection} from '../shared/file-inspection'
import {producedArtifactsForClosing} from './turn-deliverables'
import type {NS} from './locales'
import css from './ProducedFiles.styles'

export interface ProducedFilesInjected {
 isLoopback:boolean
 openNativeFile(path:string,mode:'open'|'reveal'):Promise<void>
 inspectFile?(path:string,revision:number,thumbnail:boolean,signal:AbortSignal):Promise<DisplayInspection|undefined>
 resolveFilePath?(path:string):string
 hooks:{hostDescription:HostDescriptionSource}
}
export type ProducedFilesProps=Pick<TurnTailOwnerProps,'openFile'>&Partial<Pick<TurnTailOwnerProps,'turn'|'seq'>>&{matched:readonly string[]}&PropsLocale<typeof NS>&InjectFace<ProducedFilesInjected>
const icons:Readonly<Record<ProducedFileKind,ComponentType<IconProps>>>={website:IconGlobeOutline14,pdf:IconPdfOutline24,markdown:IconMarkdownOutline24,code:IconCodeOutline16,image:IconPhotoOutline24,spreadsheet:IconSpreadsheetOutline24,presentation:IconPresentationOutline24,document:IconDocumentOutline24,video:IconMovieOutline24,audio:IconAudioOutline24,archive:IconArchiveOutline20,data:IconDatabaseOutline24,file:IconFileOutline24}
function useNearViewport(ref:RefObject<HTMLDivElement>):boolean{
 const [visible,setVisible]=useState(false)
 useEffect(()=>{
  const element=ref.current;if(!element)return
  if(typeof IntersectionObserver==='undefined'){setVisible(true);return}
  const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'80px'})
  observer.observe(element);return()=>observer.disconnect()
 },[ref])
 return visible
}
function FileCard({path,revision,change,duplicate,openFile,openNativeFile,inspectFile,resolveFilePath,canOpen,canReveal,t}:{
 path:string;revision:number;change:'created'|'modified'|undefined;duplicate:boolean;canOpen:boolean;canReveal:boolean
 openFile:ProducedFilesProps['openFile'];openNativeFile:ProducedFilesProps['openNativeFile'];inspectFile:ProducedFilesProps['inspectFile'];resolveFilePath:ProducedFilesProps['resolveFilePath'];t:ProducedFilesProps['t']
}){
 const [menuOpen,setMenuOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),[details,setDetails]=useState(false)
 const [info,setInfo]=useState<DisplayInspection>(),[url,setUrl]=useState<string>(),[imageFailed,setImageFailed]=useState(false)
 const menuId=useId(),detailId=useId(),trigger=useRef<HTMLButtonElement>(null),card=useRef<HTMLDivElement>(null),visible=useNearViewport(card)
 const type=fileType(path),Icon=icons[type.kind]
 const preview=info?['text','markdown','image','pdf'].includes(info.preview):type.preview!=='none'
 const close=()=>setMenuOpen(false)
 useEffect(()=>{
  if(!visible||!inspectFile)return
  const controller=new AbortController()
  void inspectFile(path,revision,type.kind==='image',controller.signal).then(value=>{if(!controller.signal.aborted)setInfo(value)}).catch(()=>{/* Optional metadata must not break the file card on old/offline Hosts. */})
  return()=>controller.abort()
 },[visible,inspectFile,path,revision,type.kind])
 useEffect(()=>{
  if(!visible||!info?.thumbnail){setUrl(undefined);return}
  let next:string|undefined
  try{next=thumbnailObjectUrl(info);setImageFailed(false);setUrl(next)}catch{setUrl(undefined)}
  return()=>{if(next)URL.revokeObjectURL(next)}
 },[info,visible])
 useEffect(()=>{if(!feedback)return;const timer=window.setTimeout(()=>setFeedback(''),1800);return()=>window.clearTimeout(timer)},[feedback])
 useEffect(()=>{
  if(!menuOpen)return
  const frame=requestAnimationFrame(()=>document.getElementById(menuId)?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus({preventScroll:true}))
  return()=>cancelAnimationFrame(frame)
 },[menuOpen,menuId,preview])
 const navigateMenu=(event:KeyboardEvent<HTMLDivElement>):void=>{
  if(!menuOpen||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
  const menu=document.getElementById(menuId);if(!menu?.contains(event.target instanceof Node?event.target:null))return
  const entries=Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')),index=entries.findIndex(item=>item===document.activeElement)
  const next=event.key==='Home'?entries[0]:event.key==='End'?entries.at(-1):entries[(index+(event.key==='ArrowDown'?1:-1)+entries.length)%entries.length]
  if(next){event.preventDefault();next.focus({preventScroll:true})}
 }
 const activate=():void=>{if(preview)openFile(path);else setDetails(value=>!value)}
 const select=async(id:string):Promise<void>=>{
  close();trigger.current?.focus({preventScroll:true});setError('')
  if(id==='preview'){if(preview)openFile(path);return}
  if(id==='info'){setDetails(true);return}
  if(id==='copy'){
   try{const full=resolveFilePath?.(info?.path??path)??info?.path??path;if(await writeClipboard(full))setFeedback(t('produced.copied'));else setError(t('produced.copyFailed'))}catch{setError(t('produced.copyFailed'))}
   return
  }
  if(id!=='open'&&id!=='reveal')return
  setBusy(true)
  try{await openNativeFile(path,id)}catch(error:unknown){setError(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
 }
 const items:MenuEntry[]=[preview?{id:'preview',label:t('produced.preview')}:{id:'info',label:t('produced.info')}]
 if(canReveal)items.push({id:'reveal',label:t('produced.showInFolder'),disabled:busy})
 if(canOpen)items.push({id:'open',label:t('produced.external'),disabled:busy})
 items.push({id:'copy',label:t('produced.copyPath')})
 const metadata=[t(`produced.type.${type.kind}`),info?formatFileSize(info.bytes):'',info?.width&&info.height?`${info.width} × ${info.height}`:''].filter(Boolean).join(' · ')
 return <div ref={card} className={css.cardGroup}>
  <div className={css.card} data-kind={type.kind} onKeyDown={navigateMenu}>
   <button type="button" className={css.main} title={path} aria-label={t(preview?'produced.previewFile':'produced.infoFile',{name:path})} aria-description={[metadata,change?t(`produced.${change}`):''].filter(Boolean).join(' · ')} aria-expanded={!preview?details:undefined} aria-controls={!preview&&details?detailId:undefined} onClick={activate}>
    <span className={css.icon} style={{color:type.color}} aria-hidden="true">{url&&!imageFailed?<img src={url} alt="" decoding="async" onError={()=>setImageFailed(true)}/>:<Icon size={22}/>}</span>
    <span className={css.meta}><span className={css.title}><strong>{fileName(path)}</strong>{change&&<span className={css.badge} data-change={change}>{t(`produced.${change}`)}</span>}</span><small>{metadata}</small>{duplicate&&<small className={css.parent}>{parentPath(path)||'.'}</small>}</span>
   </button>
   <Menu id={menuId} open={menuOpen} portal align="end" compact items={items} onClose={close} onSelect={id=>{void select(id)}} anchor={<button ref={trigger} type="button" className={css.open} disabled={busy} aria-busy={busy} aria-label={t('produced.openInFile',{name:path})} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen?menuId:undefined} onClick={()=>setMenuOpen(value=>!value)} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setMenuOpen(true)}}}>{t('produced.openIn')}<IconChevronDownOutline14 size={12}/></button>}/>
  </div>
  {details&&<div id={detailId} className={css.details} role="region" aria-label={t('produced.infoFile',{name:path})}>
   <p>{preview?t('produced.info'):info?.preview==='tooLarge'?t('produced.tooLarge'):t('produced.noPreview')}</p><code>{info?.path??resolveFilePath?.(path)??path}</code>
   {info?.modifiedMs!=null&&<small>{t('produced.modifiedAt')} <time dateTime={new Date(info.modifiedMs).toISOString()}>{new Date(info.modifiedMs).toLocaleString()}</time></small>}
   <button type="button" onClick={()=>setDetails(false)}>{t('produced.closeInfo')}</button>
  </div>}
  {feedback&&<p className={css.feedback} role="status">{feedback}</p>}{error&&<p role="alert" className={css.error}>{error}</p>}
 </div>
}
/** Fold by default; large result sets expand in bounded pages instead of one huge DOM. */
export function ProducedFiles({matched:paths,openFile,openNativeFile,inspectFile,resolveFilePath,isLoopback,useHostDescription,t,turn,seq}:ProducedFilesProps){
 const hostCanOpen=useHostDescription(value=>value?.canOpenPath===true),hostCanReveal=useHostDescription(value=>value?.canRevealPath===true)
 const [limit,setLimit]=useState(1),listId=useId()
 const artifacts=new Map(producedArtifactsForClosing(turn?.data.get('deliverables'),seq).map(item=>[item.path,item]))
 const counts=new Map<string,number>();for(const path of paths)counts.set(fileName(path),(counts.get(fileName(path))??0)+1)
 if(paths.length===0)return null
 const expanded=limit>1,shown=paths.slice(0,limit),remaining=paths.length-shown.length
 return <div className={css.root}><div id={listId} className={css.list}>
  {shown.map(path=>{const fact=artifacts.get(path);return <FileCard key={`${path}:${fact?.seq??0}`} path={path} revision={fact?.seq??0} change={fact?.change} duplicate={(counts.get(fileName(path))??0)>1} openFile={openFile} openNativeFile={openNativeFile} inspectFile={inspectFile} resolveFilePath={resolveFilePath} canOpen={isLoopback&&hostCanOpen} canReveal={isLoopback&&hostCanOpen&&hostCanReveal} t={t}/>})}
 </div>{paths.length>1&&<div className={css.fold}>
  {remaining>0&&<button type="button" className={css.toggle} aria-label={t(expanded?'produced.loadMore':'produced.actions')} aria-expanded={expanded} aria-controls={listId} onClick={()=>setLimit(value=>value===1?20:value+20)}>{t('produced.remaining',{count:String(remaining)})}<IconChevronDownOutline14 size={12}/></button>}
  {expanded&&<button type="button" className={css.toggle} aria-label={t('produced.actions')} aria-expanded={true} aria-controls={listId} onClick={()=>setLimit(1)}>{t('produced.collapse')}<IconChevronUpOutline14 size={12}/></button>}
 </div>}</div>
}
