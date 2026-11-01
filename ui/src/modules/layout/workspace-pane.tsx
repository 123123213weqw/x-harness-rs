import * as React from 'react'
import { pageKey, planRetainedPages, RETAINED_PAGE_IDLE_MS } from './retained-pages'
import type { RetainedPage } from './retained-pages'
import type {BrowserItem,BrowserPatch} from '../browser/index'
import {GIT_DIFF_SCOPES} from '../shared/generated/file-display-options'
import type {GitDiffScope} from '../shared/generated/file-display'
import {objectValue} from '../shared/runtime-types'

export interface WorkspaceItem extends BrowserItem {
  kind:'browser'|'tool'|'file'
  source:string
  gitDiff?:GitDiffScope|undefined
  relativeTo?:string|undefined
  sessionId?:string|undefined
}
/** Collapsed is transient presentation state; persisted browser history is unchanged. */
export interface WorkspaceSpace {items:WorkspaceItem[];activeId:string|null;collapsed?:boolean}
export type BrowserSpaces=Record<string,WorkspaceSpace>
export const xhWorkspaceEmpty:WorkspaceSpace={items:[],activeId:null}
export const xhWorkspaceStorageKey='xharness:browser-spaces-v1'
let xhBrowserPersistQueue:Promise<unknown>=Promise.resolve()
let xhLastBrowserSnapshot:string|null=null
const arrayValue=(value:unknown):unknown[]=>Array.isArray(value)?value:[]

/** Historical bounded JSON currency: only browser items are persisted. */
export function xhLoadBrowserSpaces(snapshot?:string|null):BrowserSpaces {
  try{
    const stored:unknown=JSON.parse(snapshot??localStorage.getItem(xhWorkspaceStorageKey)??'{}')
    if(!stored||typeof stored!=='object'||Array.isArray(stored))return{}
    const result:BrowserSpaces={}
    for(const [key,rawSpace] of Object.entries(objectValue(stored)).slice(-50)){
      const space=objectValue(rawSpace)
      if(typeof key!=='string'||!Array.isArray(space.items))continue
      const items:WorkspaceItem[]=arrayValue(space.items).map(objectValue).filter(item=>item.kind==='browser'&&typeof item.id==='string'&&/^[A-Za-z0-9:_-]{1,64}$/.test(item.id)).slice(-128).flatMap(item=>{
        if(typeof item.id!=='string')return[]
        const valid=arrayValue(item.entries).filter((url):url is string=>{
          try{if(typeof url!=='string')return false;const parsed=new URL(url);return url.length<=4096&&['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password}catch{return false}
        })
        return[{id:item.id,kind:'browser' as const,source:'browser',title:typeof item.title==='string'?item.title.slice(0,160):'新标签页',entries:valid.slice(-50),position:typeof item.position==='number'&&Number.isInteger(item.position)?item.position-Math.max(0,valid.length-50):-1}]
      })
      for(const item of items)item.position=Math.max(-1,Math.min(item.position,item.entries.length-1))
      const first=items[0]
      if(first!==undefined)result[key]={items,activeId:typeof space.activeId==='string'&&items.some(item=>item.id===space.activeId)?space.activeId:first.id}
    }
    return result
  }catch{return{}}
}
export function xhSaveBrowserSpaces(spaces:BrowserSpaces):void {
  const stored:BrowserSpaces={}
  for(const [key,space] of Object.entries(spaces).slice(-50)){
    const items=space.items.filter(item=>item.kind==='browser')
    if(items.length)stored[key]={items,activeId:space.activeId}
  }
  const snapshot=JSON.stringify(xhLoadBrowserSpaces(JSON.stringify(stored)))
  try{localStorage.setItem(xhWorkspaceStorageKey,snapshot)}catch{/* Origin storage can be blocked. */}
  const native=window.__TAURI__
  if(native?.core?.invoke&&snapshot!==xhLastBrowserSnapshot){
    xhLastBrowserSnapshot=snapshot
    xhBrowserPersistQueue=xhBrowserPersistQueue.catch(()=>{}).then(()=>native.core.invoke('desktop_browser_persist',{snapshot})).catch(()=>{xhLastBrowserSnapshot=null})
  }
}
export function xhNextWorkspaceId(spaces:BrowserSpaces):number {
  return Math.max(0,...Object.values(spaces).flatMap(space=>space.items.map(item=>Number(item.id.match(/^browser:(\d+)$/)?.[1])||0)))
}
export function xhWorkspaceOpen(space:WorkspaceSpace,item:WorkspaceItem,reuse=true):WorkspaceSpace {
  const existing=reuse&&space.items.find(value=>value.kind===item.kind&&value.source===item.source&&value.gitDiff===item.gitDiff&&value.relativeTo===item.relativeTo&&value.sessionId===item.sessionId)
  const visible=space.collapsed===true?{...space,collapsed:false}:space
  if(existing)return{...visible,activeId:existing.id}
  return{...visible,items:[...space.items,item],activeId:item.id}
}
/** Hiding is not tab destruction: retain the selected item, draft and history. */
export function xhWorkspaceToggle(space:WorkspaceSpace):WorkspaceSpace {
  return space.items.length?{...space,collapsed:space.collapsed!==true}:space
}
export function xhWorkspaceClose(space:WorkspaceSpace,id:string|null):WorkspaceSpace {
  const index=space.items.findIndex(item=>item.id===id)
  if(index<0)return space
  const items=space.items.filter(item=>item.id!==id)
  return{...space,items,activeId:space.activeId===id?(items[Math.min(index,items.length-1)]?.id??null):space.activeId}
}
export interface WorkspaceItemOwner extends Record<string,unknown> {
  item:WorkspaceItem;sessionId:string|null;open:boolean;onUpdate(patch:BrowserPatch):void;onClose():void;onNewBrowser():void
}
export type WorkspaceRenderSlot={
  (name:'details',owner:Record<string,never>):React.ReactNode
  (name:'workspace.item',owner:WorkspaceItemOwner):React.ReactNode
}
export function XhWorkspacePane({space,spaces,open,sessionId,renderSlot,onSelect,onClose,onUpdate,onUpdateOwner,onNewBrowser}:{
  space:WorkspaceSpace;spaces?:BrowserSpaces;open:boolean;sessionId:string|null;renderSlot:WorkspaceRenderSlot;onSelect(id:string):void;onClose(id:string):void;onUpdate(id:string,patch:BrowserPatch):void;onUpdateOwner?(owner:string,id:string,patch:BrowserPatch):void;onNewBrowser():void
}){
  const active=space.items.find(item=>item.id===space.activeId)
  const owner=sessionId??'__global__'
  const all=spaces??{[owner]:space}
  const [pages,setPages]=React.useState<readonly RetainedPage[]>([])
  const [,tick]=React.useState(0)
  const next=planRetainedPages(pages,all,owner,space.activeId,open,Date.now())
  if(next!==pages)setPages(next)
  React.useEffect(()=>{
    const deadlines=next.filter(page=>!open||page.owner!==owner||page.id!==space.activeId)
      .map(page=>page.usedAt+RETAINED_PAGE_IDLE_MS-Date.now())
    if(!deadlines.length)return
    const timer=setTimeout(()=>tick(value=>value+1),Math.max(1,Math.min(...deadlines)))
    return()=>clearTimeout(timer)
  },[next,owner,space.activeId,open])
  return <section className="xhworkspace" aria-label="工作区" hidden={!open}>
    <div className="xhworkspace-tabs" role="tablist" aria-label="工作区标签">
      {space.items.map(item=><div className="xhworkspace-tab" key={item.id} data-active={item.id===space.activeId||undefined}>
        <button type="button" role="tab" aria-selected={item.id===space.activeId} onClick={()=>onSelect(item.id)} title={item.title}>
          {item.kind!=='browser'&&<span className="xhworkspace-kind" aria-hidden>{item.kind==='tool'?'⌘':'▤'}</span>}<span className="xhworkspace-title">{item.title}</span>
        </button>
        <button type="button" className="xhworkspace-tab-close" aria-label={`关闭 ${item.title}`} onClick={()=>onClose(item.id)} title="关闭标签">×</button>
      </div>)}
      <button type="button" className="xhworkspace-new" aria-label="新建浏览器标签" onClick={onNewBrowser} title="新建浏览器标签">+</button>
    </div>
    <div className="xhworkspace-body">
      {next.map(page=>{
        const item=all[page.owner]?.items.find(item=>item.id===page.id)
        if(item===undefined)return null
        const visible=open&&page.owner===owner&&page.id===space.activeId
        return <div key={page.key} className={`xhworkspace-item xhworkspace-${item.kind}`} role="tabpanel"
          hidden={!visible} aria-hidden={!visible} style={visible?undefined:{display:'none'}}
          {...visible?{}:{inert:''}} data-workspace-page-state={visible?'visible':'retained'} data-workspace-page-owner={page.owner}>
          {renderSlot('workspace.item',{item,sessionId:page.owner==='__global__'?null:page.owner,open:visible,
            onUpdate:patch=>{if(onUpdateOwner)onUpdateOwner(page.owner,item.id,patch);else if(page.owner===owner)onUpdate(item.id,patch)},
            onClose:()=>{if(page.owner===owner)onClose(item.id)},onNewBrowser})}
        </div>
      })}
      {active?.kind==='tool'&&<div key={pageKey(owner,active.id)} className={`xhworkspace-item xhworkspace-${active.kind}`} role="tabpanel">
        {active.kind==='tool'?renderSlot('details',{}):renderSlot('workspace.item',{item:active,sessionId,open,onUpdate:patch=>onUpdate(active.id,patch),onClose:()=>onClose(active.id),onNewBrowser})}
      </div>}
    </div>
  </section>
}

export interface WorkspaceOpenDetail {kind:WorkspaceItem['kind'];fresh?:boolean;source?:string;title?:string;sessionId?:string;url?:string;relativeTo?:string;gitDiff?:GitDiffScope}
/** Actual DOM event fields produced by BrowserToggle/ToolDetails/FileView. */
export function workspaceOpenDetail(value:unknown):WorkspaceOpenDetail|undefined {
  const raw=objectValue(value)
  if(raw.kind!=='browser'&&raw.kind!=='tool'&&!(raw.kind==='file'&&typeof raw.source==='string'&&raw.source.length>0))return undefined
  const gitDiff=GIT_DIFF_SCOPES.find(scope=>scope===raw.gitDiff)
  if(raw.gitDiff!==undefined&&gitDiff===undefined)return undefined
  const kind=raw.kind
  if(kind!=='browser'&&kind!=='tool'&&kind!=='file')return undefined
  return{kind,...gitDiff===undefined?{}:{gitDiff},...typeof raw.fresh==='boolean'?{fresh:raw.fresh}:{},...typeof raw.source==='string'?{source:raw.source}:{},...typeof raw.title==='string'?{title:raw.title}:{},...typeof raw.sessionId==='string'?{sessionId:raw.sessionId}:{},...typeof raw.url==='string'?{url:raw.url}:{},...typeof raw.relativeTo==='string'?{relativeTo:raw.relativeTo}:{}}
}
