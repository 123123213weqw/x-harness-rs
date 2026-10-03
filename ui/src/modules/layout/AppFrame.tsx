/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details), the drag handles (pointer capture + rAF throttle), the concession
 * chain (columns.ts), and the child-slot render decisions: the sidebar slot
 * renders HERE with live parameters from the concession solve, and the
 * session-aware occupants render in fixed column positions; strict entries
 * gate themselves on current-session availability while session-maybe
 * entries retain identity. Pure component: everything arrives
 * through the three framework shares — zero cordis or framework imports,
 * zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '../views-types'
import { computeColumns, clampWidth, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns'
import type { createLayoutStore } from './stores'
import css from './AppFrame.styles'
import {xhCreateBrowserWindowController} from './browser-window-controller'
import {xhLoadBrowserSpaces,xhSaveBrowserSpaces,xhNextWorkspaceId,xhWorkspaceEmpty,xhWorkspaceOpen,xhWorkspaceClose,XhWorkspacePane,workspaceOpenDetail} from './workspace-pane'
import type {BrowserSpaces,WorkspaceItem,WorkspaceSpace,WorkspaceOpenDetail} from './workspace-pane'
import type {BrowserPatch} from '../browser/index'
const xhWorkspaceWindow=xhCreateBrowserWindowController(typeof window==='undefined'?undefined:window.__TAURI__)

/** Full composed props: runtime share + child-slot render share + store share. */
export interface AppFrameProps extends PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay' | 'workspace.item'> {
  useSessions<T>(select: (state: import('../views-types').SessionSnapshot) => T): T
  useStore<T>(select: (state: import('./stores').LayoutState) => T): T
  actions: import('./service').PanelActions
}

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [pluginCenterOpen, setPluginCenterOpen] = useState(false)
  const closePluginCenter = (): void => {
    setPluginCenterOpen(false)
    window.dispatchEvent(new Event('xharness:plugins:closed'))
  }
  useEffect(() => {
    const open = (): void => {setPluginCenterOpen(true)}
    window.addEventListener('xharness:plugins:open', open)
    return () => {window.removeEventListener('xharness:plugins:open', open)}
  }, [])
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const spaceKey=useSessions(state=>state.current??'__global__')
  const spaceKeyRef=useRef(spaceKey);spaceKeyRef.current=spaceKey
  const [spaces,setSpaces]=useState<BrowserSpaces>(xhLoadBrowserSpaces)
  const [browserRestored,setBrowserRestored]=useState(!window.__TAURI__?.core?.invoke)
  const space=spaces[spaceKey]??xhWorkspaceEmpty
  const nextWorkspaceId=useRef(xhNextWorkspaceId(spaces))
  useEffect(()=>{
    if(browserRestored)xhSaveBrowserSpaces(spaces)
    nextWorkspaceId.current=Math.max(nextWorkspaceId.current,xhNextWorkspaceId(spaces))
  },[spaces,browserRestored])
  useEffect(()=>{
    const native=window.__TAURI__
    if(!native?.core?.invoke)return
    let alive=true
    native.core.invoke('desktop_browser_restore').then(snapshot=>{
      if(alive&&typeof snapshot==='string'&&snapshot)setSpaces(xhLoadBrowserSpaces(snapshot))
    }).catch(()=>{}).finally(()=>{if(alive)setBrowserRestored(true)})
    return()=>{alive=false}
  },[])
  const [workspaceWidth,setWorkspaceWidth]=useState(440)
  const updateSpace=(fn:(space:WorkspaceSpace)=>WorkspaceSpace):void=>setSpaces(all=>{
    const key=spaceKeyRef.current
    return{...all,[key]:fn(all[key]??xhWorkspaceEmpty)}
  })
  const openWorkspace=(kind:WorkspaceItem['kind'],fresh=false,detail:Omit<WorkspaceOpenDetail,'kind'>={}):void=>{
    const id=kind==='tool'?'tool':`${kind}:${++nextWorkspaceId.current}`
    const source=kind==='file'?detail.source:kind
    if(source===undefined)return
    const item:WorkspaceItem={id,kind,source,sessionId:detail.sessionId,title:kind==='tool'?'工具详情':kind==='file'?(detail.title||source.split(/[\\/]/).at(-1)||''):'新标签页',entries:detail.url?[detail.url]:[],position:detail.url?0:-1}
    updateSpace(value=>xhWorkspaceOpen(value,item,!fresh))
  }
  const closeWorkspace=(id:string|null):void=>{
    if(id==='tool')actions.closeDetails()
    if(space.items.some(item=>item.id===id&&item.kind==='browser'))window.dispatchEvent(new CustomEvent('xharness:browser-close',{detail:{id}}))
    updateSpace(value=>xhWorkspaceClose(value,id))
  }
  useEffect(()=>{
    const onOpen=(event:Event):void=>{
      const value:unknown=event instanceof CustomEvent?event.detail:undefined
      const detail=workspaceOpenDetail(value)
      if(detail)openWorkspace(detail.kind,detail.fresh===true,detail)
    }
    const onCloseTool=():void=>updateSpace(value=>xhWorkspaceClose(value,'tool'))
    window.addEventListener('xharness:workspace-open',onOpen)
    window.addEventListener('xharness:workspace-close-tool',onCloseTool)
    return()=>{window.removeEventListener('xharness:workspace-open',onOpen);window.removeEventListener('xharness:workspace-close-tool',onCloseTool)}
  },[])
  useEffect(()=>{
    setSpaces(all=>{
      let changed=false
      const next={...all}
      for(const [key,value] of Object.entries(next))if(key!==spaceKey&&value.items.some(item=>item.kind==='tool')){next[key]=xhWorkspaceClose(value,'tool');changed=true}
      return changed?next:all
    })
  },[spaceKey])
  useEffect(()=>{void xhWorkspaceWindow.set(space.items.length>0,440)},[space.items.length>0])
  useEffect(()=>()=>{void xhWorkspaceWindow.set(false)},[])


  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). A narrow manual expansion is a drawer:
  // the solver keeps the control rail reserved and never squeezes the center.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarDrawer = narrow && !sidebarCollapsed
  const sidebarWidth=sidebarCollapsed||sidebarDrawer?56:panels.sidebar===0?SIDEBAR_DEFAULT:clampWidth(panels.sidebar,264,420)
  const workspaceOpen=space.items.length>0
  const workspaceAvailable=viewport-sidebarWidth-480
  const workspaceDrawer=workspaceOpen&&workspaceAvailable<360
  const workspaceDockWidth=workspaceOpen&&!workspaceDrawer?Math.min(workspaceWidth,workspaceAvailable):0
  const cols=computeColumns(viewport-workspaceDockWidth,sidebarCollapsed||sidebarDrawer?0:panels.sidebar===0?SIDEBAR_DEFAULT:panels.sidebar,0,workspaceDockWidth>0?480:640)
  const colsRef = useRef(cols)
  colsRef.current = cols

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const workspaceBase=useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onWorkspaceStart=():void=>{workspaceBase.current=workspaceDockWidth;setDragging(true)}
  const onWorkspaceDrag=(dx:number):void=>{if(dx<0)setWorkspaceWidth(Math.max(workspaceBase.current,Math.min(900,workspaceAvailable,workspaceBase.current-dx)))}
  const updateItem=(id:string,patch:BrowserPatch):void=>updateSpace(value=>({...value,items:value.items.map(item=>item.id===id?{...item,...patch}:item)}))

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${workspaceDockWidth}px` }}
      data-xhworkspace-open={workspaceOpen||undefined}
      data-xhworkspace-drawer={workspaceDrawer||undefined}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-sidebar-drawer={sidebarDrawer || undefined}
      data-details-collapsed={!workspaceOpen||undefined}
      data-dragging={dragging || undefined}
    >
      {sidebarDrawer && <button type="button" className="xh-sidebar-scrim" aria-label={navigator.language.startsWith('zh') ? '关闭侧栏' : 'Close sidebar'} onClick={actions.toggleSidebar} />}
      <div className={css.sidebarCol} style={sidebarDrawer ? { width: Math.min(viewport - 24, panels.sidebar === 0 ? SIDEBAR_DEFAULT : clampWidth(panels.sidebar,264,420)) } : undefined} onClickCapture={event => {
        const target = event.target
        if (pluginCenterOpen && (!(target instanceof Element) || !target.closest('[data-xharness-plugin-nav]'))) closePluginCenter()
      }} onClick={event => {
        // Row actions stop propagation; dismiss only a completed navigation
        // click after the row has handled it, keeping its menu mounted.
        const target = event.target
        if (sidebarDrawer && target instanceof Element && target.closest('[role="treeitem"][aria-selected]')) actions.toggleSidebar()
      }}>
        {/* Render-site slot call with live concession output: a closed
            sidebar keeps the mounted slot at the compact-rail width, and the
            component sees its rendered state as owner params decided here
            (collapsed follows the resolved rail, so a derived auto-collapse
            renders the rail UI too). */}
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: sidebarDrawer ? Math.min(viewport - 24, panels.sidebar === 0 ? SIDEBAR_DEFAULT : clampWidth(panels.sidebar,264,420)) : cols.sidebar,
        })}
      </div>
      <>
        {/* Both column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current. */}
        <CenterColumn>{pluginCenterOpen ? <main style={{flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px clamp(20px, 5vw, 56px)'}}>
          <button type="button" style={{cursor: 'pointer', background: 'none', border: 0, color: 'var(--dsw-alias-label-secondary)', padding: '0 0 24px', font: 'inherit'}}
            aria-label="Back to chat" onClick={closePluginCenter}>← {navigator.language.startsWith('zh') ? '返回对话' : 'Back to chat'}</button>
          {renderSlot('plugins.center', {})}
        </main> : renderSlot('conversation', {})}</CenterColumn>
        {workspaceDrawer&&<button type="button" className={css.workspaceScrim} aria-label="关闭工作区" onClick={()=>closeWorkspace(space.activeId)} />}
        <DetailsColumn><XhWorkspacePane space={space} sessionId={spaceKey==='__global__'?null:spaceKey} renderSlot={renderSlot} onSelect={id=>updateSpace(value=>({...value,activeId:id}))} onClose={closeWorkspace} onUpdate={updateItem} onNewBrowser={()=>openWorkspace('browser',true)} /></DetailsColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!sidebarCollapsed && !sidebarDrawer && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {workspaceDockWidth>0&&<DragHandle side="details" left={viewport-workspaceDockWidth} onStart={onWorkspaceStart} onDrag={onWorkspaceDrag} onEnd={onDragEnd} />}
    </div>
  )
}
