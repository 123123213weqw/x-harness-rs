/// <reference path="../shared/assets.d.ts" />
import * as React from 'react'
import type { NativeUnlisten } from '../shared/tauri'
import type { EffectContext, SlotsService } from '../shared/runtime-types'
import { objectValue } from '../shared/runtime-types'
import { workspaceDockEvents, workspaceDockVisibility } from '../shared/workspace-dock'
import CSS from './Browser.css'
const { createElement: h, useEffect, useRef, useState } = React
export interface BrowserItem { id: string; kind: string; title: string; entries: readonly string[]; position: number; modelRequestId?: string | undefined }
export interface BrowserPatch { title?: string; entries?: string[]; position?: number; modelRequestId?: string | undefined }
export interface BrowserPaneProps { item: BrowserItem; sessionId?: string | null; open?: boolean; onUpdate(patch: BrowserPatch): void; onClose(): void; onNewBrowser(): void }
interface BrowserContext extends EffectContext { slots: SlotsService }
type AddressResult = {url: string} | {error: string}
interface RecentAddress {url: string; host: string; path: string}
interface DownloadEntry {kind: string; name: string}
function arrayValue(raw: unknown): unknown[] { return Array.isArray(raw) ? raw : [] }
const DOWNLOAD_LABELS: Readonly<Record<string, string>> = { 'download-start': '下载中', 'download-complete': '已完成', 'download-error': '失败' }
function browserPayload(raw: unknown): {tabId: string; kind: string; value: string} | undefined {
  const payload = objectValue(raw)
  return typeof payload.tabId === 'string' && typeof payload.kind === 'string' && typeof payload.value === 'string'
    ? {tabId: payload.tabId, kind: payload.kind, value: payload.value} : undefined
}
const STYLE_ID = 'xharness-browser-pane-style'
const OPEN_EVENT = 'xharness:workspace-open'
const native = window.__TAURI__?.core?.invoke ? window.__TAURI__ : null
let nativeQueue: Promise<unknown> = Promise.resolve()
const enqueueNative = <T,>(task: () => T | PromiseLike<T>): Promise<T> => {
  const result = nativeQueue.then(task)
  nativeQueue = result.catch(() => {})
  return result
}
const invoke = (command: string, args: Record<string, unknown>) => enqueueNative(() => {
  if (!native) return Promise.reject(new Error('Desktop browser unavailable'))
  return native.core.invoke(command, args)
})

export function normalizeAddress(raw: string): AddressResult {
  const value = raw.trim()
  if (!value) return { error: '请输入网址' }
  if (/\s/.test(value)) return { error: '请输入完整网址，暂不支持搜索词' }
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `${/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw Error('unsupported URL')
    return { url: url.href }
  } catch { return { error: '仅支持有效的 http/https 网址' } }
}
const currentAddress = (item: BrowserItem) => item.entries?.[item.position] ?? ''
const browserHistoryKey = 'xharness:browser-spaces-v1'
function recentAddresses(item: BrowserItem) {
  let spaces: Record<string, unknown> = {}
  try { spaces = objectValue(JSON.parse(localStorage.getItem(browserHistoryKey) || '{}')) } catch { /* Private storage may be unavailable. */ }
  const items = [item, ...Object.values(spaces).flatMap(space => arrayValue(objectValue(space).items))]
  const seen = new Set()
  const result: RecentAddress[] = []
  for (const tab of items) {
    for (const raw of [...(arrayValue(objectValue(tab).entries))].reverse()) {
      try {
        if (typeof raw !== 'string') continue
        const url = new URL(raw)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue
        seen.add(url.href)
        result.push({ url: url.href, host: url.hostname, path: url.pathname === '/' ? '' : url.pathname })
        if (result.length === 8) return result
      } catch { /* Ignore stale or malformed history entries. */ }
    }
  }
  return result
}
const glyph = (name: string, size = 16) => {
  const paths: Readonly<Record<string, React.ReactNode>> = {
    globe: [h('circle', { cx: 12, cy: 12, r: 9, key: 1 }), h('path', { d: 'M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18', key: 2 })],
    left: [h('path', { d: 'm14 5-7 7 7 7', key: 1 })],
    right: [h('path', { d: 'm10 5 7 7-7 7', key: 1 })],
    reload: [h('path', { d: 'M20 11a8 8 0 1 0-2.5 6', key: 1 }), h('path', { d: 'M20 4v7h-7', key: 2 })],
    annotate: [h('path', { d: 'M5 18h5M7 14l8-8 3 3-8 8-4 1 1-4ZM14 7l3 3', key: 1 })],
    chat: [h('path', { d: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 2v-5.5a7.5 7.5 0 1 1 16-4Z', key: 1 })],
    download: [h('path', { d: 'M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3', key: 1 })],
    more: [h('circle', { cx: 5, cy: 12, r: 1, key: 1 }), h('circle', { cx: 12, cy: 12, r: 1, key: 2 }), h('circle', { cx: 19, cy: 12, r: 1, key: 3 })],
    external: [h('path', { d: 'M13 5h6v6M19 5l-9 9M19 14v5H5V5h5', key: 1 })],
  }
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, paths[name])
}
const button = (label: string, icon: string, onClick: () => void, disabled = false) => h('button', { type: 'button', className: 'xhbrowser-icon',
  'aria-label': label, title: label, onClick, disabled }, glyph(icon))

export function BrowserToggle() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onVisibility = (event: Event) => {
      const visible = workspaceDockVisibility(event)
      if (visible !== undefined) setOpen(visible)
    }
    window.addEventListener(workspaceDockEvents.visibility, onVisibility)
    // A header can mount after browser/session restoration. Ask the owner for
    // its current state instead of guessing from the last request we sent.
    window.dispatchEvent(new Event(workspaceDockEvents.requestVisibility))
    return () => window.removeEventListener(workspaceDockEvents.visibility, onVisibility)
  }, [])
  const label = open ? '收起右侧工作区' : '展开右侧工作区'
  return h('button', { type: 'button', className: 'xhbrowser-header-trigger', 'aria-label': label,
    'aria-expanded': open, title: label,
    onClick: () => window.dispatchEvent(new Event(workspaceDockEvents.toggle)) },
    h('svg', { className: 'xhbrowser-dock-icon', width: 16, height: 16, viewBox: '0 0 16 16',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { className: 'xhbrowser-dock-panel', d: 'M10 2h3.4A1.6 1.6 0 0 1 15 3.6v8.8a1.6 1.6 0 0 1-1.6 1.6H10Z', fill: 'currentColor', stroke: 'none' }),
      h('rect', { x: 1, y: 2, width: 14, height: 12, rx: 1.6 }),
      h('path', { d: 'M10 2v12' }),
      h('g', { className: 'xhbrowser-dock-chevron' }, h('path', { d: 'm13.5 6-2 2 2 2' }))))
}
const accessText = (zh: string, en: string) => document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en
const pageOrigin = (address: string) => {
  try { const url = new URL(address); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : '' } catch { return '' }
}
// Native child views cannot participate in CSS stacking. Yield only while
// a rendered modal or a floating UI surface covers their page rectangle.
// ARIA surfaces and body portals share this policy; no hashed CSS names.
const MODAL_SURFACE = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
const OVERLAY_SURFACE = `${MODAL_SURFACE}, [role="menu"], [role="listbox"], [role="tooltip"], [popover], [data-xh-overlay]`
const floating = (element: Element) => ['fixed', 'absolute'].includes(getComputedStyle(element).position)
function browserSurfaces(content: Element) {
  const surfaces = new Set(document.querySelectorAll(OVERLAY_SURFACE))
  const addFloating = (root: Element) => {
    if (root.contains(content)) return
    if (floating(root)) surfaces.add(root)
    else for (const child of root.querySelectorAll('*')) if (floating(child)) surfaces.add(child)
  }
  // The shell carrier spans the viewport even when empty; only its entries
  // are overlays. Treating the carrier as one would hide every native page.
  for (const root of document.querySelectorAll('[data-shell-overlay]')) for (const entry of root.children) addFloating(entry)
  for (const root of document.body.children) if (!root.contains(content)) addFloating(root)
  return [...surfaces].filter(element => !content.contains(element))
}
function browserOccluded(content: Element) {
  const page = content.getBoundingClientRect()
  return browserSurfaces(content).some(element => {
    if (element.closest('[hidden], [aria-hidden="true"], [inert]') || !element.getClientRects().length) return false
    if (getComputedStyle(element).visibility !== 'visible') return false
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false
    if (element.matches(MODAL_SURFACE)) return true
    // A static listbox in chat is content, not a floating menu.
    let surface: Element | null = element
    while (surface && surface !== document.body && !surface.contains(content) && !floating(surface)) surface = surface.parentElement
    if (!surface || surface === document.body || surface.contains(content)) return false
    return rect.left < page.right && rect.right > page.left && rect.top < page.bottom && rect.bottom > page.top
  })
}
function watchBrowserSurfaces(content: Element, sync: () => Promise<boolean>) {
  let frame: number | null = null
  let surfaces: Element[] = []
  const resize = new ResizeObserver(() => schedule())
  const refresh = () => {
    frame = null
    const next = browserSurfaces(content)
    if (next.length !== surfaces.length || next.some((element, index) => element !== surfaces[index])) {
      resize.disconnect(); next.forEach(element => resize.observe(element)); surfaces = next
    }
    void sync()
  }
  const schedule = () => { frame ??= requestAnimationFrame(refresh) }
  const relevant = (node: Node | EventTarget | null) => node instanceof Element && (
    node.closest(`${OVERLAY_SURFACE}, [data-shell-overlay]`) || node.querySelector(OVERLAY_SURFACE)
    || surfaces.some(surface => node.contains(surface))
    || [...document.body.children].some(root => !root.contains(content) && root.contains(node)))
  const observer = new MutationObserver(records => {
    // Ignore streaming text/tool rows. Only overlay/portal ownership changes
    // invalidate native presentation; coalesce them once per animation frame.
    if (records.some(record => record.target === document.body || relevant(record.target)
      || [...record.addedNodes, ...record.removedNodes].some(relevant))) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'inert', 'role', 'aria-modal', 'aria-hidden', 'popover', 'data-xh-overlay'] })
  window.addEventListener('scroll', schedule, true)
  const settled = (event: Event) => { if (relevant(event.target)) schedule() }
  document.addEventListener('transitionend', settled)
  document.addEventListener('animationend', settled)
  schedule()
  return () => {
    observer.disconnect(); resize.disconnect(); if (frame !== null) cancelAnimationFrame(frame)
    window.removeEventListener('scroll', schedule, true)
    document.removeEventListener('transitionend', settled); document.removeEventListener('animationend', settled)
  }
}
export function BrowserPane({ item, sessionId = null, open = false, onUpdate, onClose, onNewBrowser }: BrowserPaneProps) {
  const [draft, setDraft] = useState(() => currentAddress(item))
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [downloads, setDownloads] = useState<DownloadEntry[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const itemRef = useRef(item)
  itemRef.current = item
  const sessionRef = useRef(sessionId); sessionRef.current = sessionId
  const address = currentAddress(item)
  const recent = recentAddresses(item).filter(site => site.url !== address)
  // One coordinator owns activation, including pending navigation and overlays.
  const presentationRef = useRef({ open, blocked: menuOpen || downloadsOpen })
  presentationRef.current = { open, blocked: menuOpen || downloadsOpen }
  const nativeSyncRef = useRef<(() => Promise<boolean>) | null>(null)
  const navigationRef = useRef<{ tabId: string; url: string } | null>(null)
  useEffect(() => { setDraft(address); setError('') }, [address])
  useEffect(() => {
    if (!native || !open || !contentRef.current) return
    const content = contentRef.current
    let disposed = false
    let generation = 0
    let lastGeometry = ''
    let binding: {key: string; until: number} | null = null
    let renewalTimer: ReturnType<typeof setTimeout> | undefined
    let loading = false
    let completing = false
    let eventsReady = false
    let pageVersion = 0
    let locationFrame: number | null = null
    const send = (command: string, args: Record<string, unknown>) => native.core.invoke(command, args)
    const visible = () => {
      if (disposed || sessionRef.current !== sessionId || itemRef.current.id !== item.id || !presentationRef.current.open || presentationRef.current.blocked || !currentAddress(itemRef.current)) return false
      const content = contentRef.current
      const rect = content?.getBoundingClientRect()
      if (!content || !rect || rect.width < 1 || rect.height < 1) return false
      return !content.closest('[hidden], [aria-hidden="true"], [inert]') && !browserOccluded(content)
    }
    const hide = async () => {
      await send('desktop_browser_activate', { tabId: null })
      lastGeometry = 'hidden'; binding = null
      clearTimeout(renewalTimer)
    }
    const syncBounds = () => {
      const requested = ++generation
      return enqueueNative(async () => {
        if (disposed || !eventsReady || requested !== generation) return false
        const current = () => requested === generation && visible()
        if (!current()) {
          if (lastGeometry !== 'hidden') await hide()
          return false
        }
        const rect = content.getBoundingClientRect()
        const url = currentAddress(itemRef.current)
        const pending = navigationRef.current?.tabId === item.id ? navigationRef.current : null
        const geometry = [rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value * 2) / 2).join(',') + `:${url}`
        if (geometry !== lastGeometry || pending) {
          await send('desktop_browser_bounds', { bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })
          if (!current()) { await hide(); return false }
          const exists = await send('desktop_browser_activate', { tabId: item.id })
          if (!current()) { await hide(); return false }
          if (!exists || pending) {
            loading = true
            await send('desktop_browser_navigate', { tabId: item.id, url: pending?.url ?? url })
            if (navigationRef.current === pending) navigationRef.current = null
            if (!current()) { await hide(); return false }
          }
          lastGeometry = geometry
        }
        // Bind only the actual visible chat/page. The model chooses observe or
        // perform through plugin_mcp; its existing approval policy still applies.
        const origin = pageOrigin(url)
        const key = JSON.stringify([sessionId, origin])
        if (!loading && sessionId && origin && (binding?.key !== key || binding.until <= performance.now())) {
          let result: unknown
          try { result = await send('desktop_browser_delegate', { tabId: item.id, owner: sessionId, allowActions: true, expectedOrigin: origin }) }
          catch (error) { await hide(); throw error }
          if (!current() || pageOrigin(currentAddress(itemRef.current)) !== origin) { await hide(); return false }
          const reply = objectValue(result)
          const grant = objectValue(reply.grant)
          if (reply.origin !== origin || grant.owner !== sessionId || grant.allowActions !== true
            || typeof grant.remainingMs !== 'number' || !Number.isFinite(grant.remainingMs) || grant.remainingMs <= 0 || grant.remainingMs > 600000) {
            await hide()
            throw Error(accessText('浏览器会话绑定失败，请检查桌面版本。', 'Browser session binding failed; check the desktop version.'))
          }
          // No status polling or extra permission UI. Refresh the same binding
          // before expiry; native renewal preserves the current observation frame.
          const delay = Math.max(1000, Math.min(300000, grant.remainingMs / 2))
          binding = { key, until: performance.now() + delay }
          clearTimeout(renewalTimer)
          renewalTimer = setTimeout(syncBounds, delay)
        }
        const requestId=itemRef.current.modelRequestId
        if(!loading&&binding&&requestId&&!completing){
          completing=true
          const accepted=await send('desktop_browser_control_reply',{requestId,reply:{status:'ready',tab_id:item.id}})
          if(accepted===true){
            onUpdate({modelRequestId:undefined})
            window.dispatchEvent(new CustomEvent('xharness:browser-control-settled',{detail:requestId}))
          }
          else completing=false
        }
        return true
      }).catch((error: unknown) => {
        if (!disposed && requested === generation) { setError(String(error)) }
        return false
      })
    }
    nativeSyncRef.current = syncBounds
    const updateAddress = (value: string) => {
      const current = itemRef.current
      const entries = current.entries ?? []
      if (entries[current.position] === value) return
      const previous = entries.lastIndexOf(value)
      const patch = previous >= 0
        ? { position: previous, title: new URL(value).hostname }
        : { entries: [...entries.slice(0, current.position + 1), value], position: current.position + 1, title: new URL(value).hostname }
      itemRef.current = { ...current, ...patch }
      onUpdate(patch)
    }
    const sampleLocation = () => {
      // Coalesce iframe policy bursts; no background polling. A top-level
      // load event arriving during this request supersedes the stale sample.
      if (locationFrame !== null) return
      locationFrame = requestAnimationFrame(() => {
        locationFrame = null
        const version = pageVersion
        void enqueueNative(async () => {
          if (!visible()) return
          const result = objectValue(await send('desktop_browser_page_state', { tabId: item.id }))
          if (!visible() || version !== pageVersion || typeof result.url !== 'string' || typeof result.loaded !== 'boolean') return
          const url = new URL(result.url)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
          loading = !result.loaded
          updateAddress(url.href)
          void syncBounds()
        }).catch(() => { /* A hidden/closed tab is not an actionable sample. */ })
      })
    }
    const observer = new ResizeObserver(syncBounds)
    observer.observe(content)
    const stopWatchingSurfaces = watchBrowserSurfaces(content, syncBounds)
    window.addEventListener('resize', syncBounds)
    let unlisten: NativeUnlisten | null = null
    native.event.listen('xharness-browser-event', event => {
      const payload = browserPayload(event.payload)
      if (disposed || !payload || payload.tabId !== item.id) return
      if (payload.kind === 'url') {
        // Only native top-level page-load events publish this address. The
        // separate loading/loaded events own readiness; a duplicate address
        // notification must not leave an already-ready page waiting forever.
        pageVersion++
        updateAddress(payload.value)
      } else if (payload.kind === 'title') onUpdate({ title: payload.value || item.title })
      else if (payload.kind === 'navigation-policy') sampleLocation()
      else if (payload.kind === 'location-error') setError(payload.value || 'Native address updates are unavailable')
      else if (payload.kind === 'loading') { pageVersion++; loading = true }
      else if (payload.kind === 'loaded') { pageVersion++; loading = false; void syncBounds() }
      else if (payload.kind.startsWith('download-')) {
        setDownloads(previous => [{ kind: payload.kind, name: String(payload.value || '').split(/[/\\]/).pop() || '下载文件' }, ...previous].slice(0, 5))
        if (payload.kind === 'download-error') setError(payload.value || '下载失败')
      }
      else if (payload.kind === 'blocked-url') setError(`已阻止非网页链接：${payload.value}`)
    }).then(fn => { if (disposed) fn(); else { unlisten = fn; eventsReady = true; requestAnimationFrame(syncBounds) } }).catch((error: unknown) => { if (!disposed) setError(String(error)) })
    return () => {
      disposed = true; generation++; clearTimeout(renewalTimer); observer.disconnect(); stopWatchingSurfaces(); window.removeEventListener('resize', syncBounds); unlisten?.()
      if (locationFrame !== null) cancelAnimationFrame(locationFrame)
      if (nativeSyncRef.current === syncBounds) nativeSyncRef.current = null
      const requestId=itemRef.current.modelRequestId
      if(requestId){
        // Closing/switching chats cancels the rendezvous immediately, not after
        // its full load timeout. Native verifies the main caller and request ID.
        void native.core.invoke('desktop_browser_control_reply',{requestId,reply:{status:'failed'}}).catch(()=>{})
        void invoke('desktop_browser_close',{tabId:item.id}).catch(()=>{})
      }
      void invoke('desktop_browser_activate', { tabId: null }).catch(() => {})
    }
  }, [item.id, open, sessionId])
  useEffect(() => { nativeSyncRef.current?.() }, [menuOpen, downloadsOpen, address, item.id, open, sessionId])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && !((event.metaKey || event.ctrlKey) && ['l', 't'].includes(event.key.toLowerCase()))) return
      if (event.defaultPrevented || (contentRef.current && browserOccluded(contentRef.current))) return
      if (event.key === 'Escape') {
        if (menuOpen || downloadsOpen) { event.preventDefault(); setMenuOpen(false); setDownloadsOpen(false); return }
        if (event.target instanceof Element && event.target.closest('.xhbrowser-pane')) onClose()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
        event.preventDefault(); onNewBrowser()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, onNewBrowser, menuOpen, downloadsOpen])
  const navigateTo = (raw: string) => {
    const result = normalizeAddress(raw)
    if ('error' in result) { setError(result.error); return }
    const entries = [...(item.entries ?? []).slice(0, item.position + 1), result.url]
    itemRef.current = { ...itemRef.current, entries, position: entries.length - 1 }
    onUpdate({ entries, position: entries.length - 1, title: new URL(result.url).hostname })
    setDraft(result.url); setError('')
    if (native) {
      navigationRef.current = { tabId: item.id, url: result.url }
      nativeSyncRef.current?.()
    }
  }
  const navigate = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); navigateTo(draft) }
  const composerTarget = () => [...document.querySelectorAll<HTMLTextAreaElement>('[data-composer-seat] textarea, [data-composer-card] textarea')]
    .find(element => !element.disabled && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
  const focusChat = () => {
    if (!composerTarget()) { setError('当前页面没有可用的聊天输入框'); return }
    setError('')
    if (document.querySelector('[data-xhworkspace-drawer]')) onClose()
    requestAnimationFrame(() => composerTarget()?.focus())
  }
  const openTerminal = () => {
    const terminal = [...document.querySelectorAll<HTMLButtonElement>('[data-xh-terminal-trigger]')]
      .find(element => !element.disabled && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    if (!terminal) { setError('当前页面没有可用的终端'); return }
    setError('')
    if (terminal.getAttribute('data-xh-terminal-open') !== 'true') terminal.click()
  }
  const copyAddress = async () => {
    if (!address) return
    try { await navigator.clipboard.writeText(address); setMenuOpen(false) }
    catch { setError('复制地址失败') }
  }
  const move = (offset: number) => {
    if (native) {
      void invoke('desktop_browser_action', { tabId: item.id, action: offset < 0 ? 'back' : 'forward' }).catch((error: unknown) => setError(String(error)))
      return
    }
    const position = Math.max(0, Math.min(item.entries.length - 1, item.position + offset))
    const target = item.entries[position]
    if (target === undefined) return
    onUpdate({ position, title: new URL(target).hostname })
  }
  const canBack = item.position > 0
  const canForward = item.position < (item.entries?.length ?? 0) - 1
  return h('section', { className: 'xhbrowser-pane', 'aria-label': '内置浏览器面板' },
    h('div', { className: 'xhbrowser-toolbar' },
      h('div', { className: 'xhbrowser-nav', 'aria-label': '网页导航' },
        button('后退', 'left', () => move(-1), !canBack),
        button('前进', 'right', () => move(1), !canForward),
        h('span', { className: 'xhbrowser-nav-divider', 'aria-hidden': true }),
        button('刷新', 'reload', () => { if (native) void invoke('desktop_browser_action', { tabId: item.id, action: 'reload' }).catch((error: unknown) => setError(String(error))) }, !native || !address)),
      h('button', { type: 'button', className: 'xhbrowser-annotate', disabled: true, title: '网页标注尚未接入', 'aria-label': '标注（尚未接入）' },
        glyph('annotate', 16), h('span', null, '标注')),
      h('form', { className: 'xhbrowser-address-form', onSubmit: navigate },
        h('input', { ref: inputRef, type: 'text', value: draft,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value); setError('') }, 'aria-label': '网址',
          placeholder: '搜索或输入网址', autoComplete: 'url', spellCheck: false })),
      h('div', { className: 'xhbrowser-actions', 'aria-label': '浏览器工具' },
        button('回到聊天', 'chat', focusChat),
        h('button', { type: 'button', className: 'xhbrowser-icon xhbrowser-download', 'aria-label': '下载记录',
          'aria-expanded': downloadsOpen, title: '下载记录', onClick: () => { setDownloadsOpen(value => !value); setMenuOpen(false) } }, glyph('download'))),
      h('button', { type: 'button', className: 'xhbrowser-more', 'aria-label': '更多浏览器操作', 'aria-expanded': menuOpen,
        onClick: () => { setMenuOpen(value => !value); setDownloadsOpen(false) } }, glyph('more'))),
    downloadsOpen && h('div', { className: 'xhbrowser-downloads', role: 'region', 'aria-label': '下载记录' },
      h('strong', null, '下载记录'),
      downloads.length ? downloads.map((entry, index) => h('div', { key: `${index}:${entry.name}` },
        h('span', null, entry.name), h('small', null, DOWNLOAD_LABELS[entry.kind])))
        : h('p', null, native ? '本次会话还没有下载。' : '网页版没有内置下载记录。')),
    menuOpen && h('div', { className: 'xhbrowser-menu' },
      h('button', { type: 'button', onClick: () => { onNewBrowser(); setMenuOpen(false) } }, '新建标签页'),
      h('button', { type: 'button', disabled: !address, onClick: copyAddress }, '复制当前网址'),
      address && h('a', { href: address, target: '_blank', rel: 'noopener noreferrer', onClick: () => setMenuOpen(false) }, '在系统浏览器打开')),
    error && h('div', { className: 'xhbrowser-error', role: 'alert' }, error),
    h('div', { className: `xhbrowser-content${address ? '' : ' xhbrowser-content-home'}`, ref: contentRef },
      !address ? h('div', { className: 'xhbrowser-home' },
        h('section', { className: 'xhbrowser-home-section' },
          h('h2', null, '工具'),
          h('div', { className: 'xhbrowser-tools' },
            h('button', { type: 'button', onClick: focusChat }, '回到聊天'),
            h('button', { type: 'button', onClick: openTerminal }, '打开终端'))),
        recent.length > 0 && h('section', { className: 'xhbrowser-home-section' },
          h('h2', null, '最近访问'),
          h('div', { className: 'xhbrowser-recents' }, recent.map(site => h('button', {
            type: 'button', key: site.url, onClick: () => navigateTo(site.url), title: site.url,
          }, h('span', { className: 'xhbrowser-site-mark', 'aria-hidden': true }, glyph('globe', 16)),
          h('span', { className: 'xhbrowser-site-label' }, h('strong', null, site.host), site.path && h('small', null, site.path)))))),
        recent.length === 0 && h('p', { className: 'xhbrowser-home-hint' }, '在上方输入网址，访问过的网页会出现在这里。'))
        : !native && h('div', { className: 'xhbrowser-empty' },
          h('div', { className: 'xhbrowser-empty-mark' }, glyph('globe', 31)),
          h('h2', null, '网页已准备好'),
          h('p', null, `网页版不能嵌入 ${new URL(address).hostname}，请在桌面软件打开。`),
          h('a', { className: 'xhbrowser-open-link', href: address, target: '_blank', rel: 'noopener noreferrer' },
            '在系统浏览器打开', glyph('external', 15)))))
}
export const inject = ['slots']
export function apply(ctx: BrowserContext) {
  ctx.effect(() => {
    if (!native) return () => {}
    const onCloseTab = (event: Event) => {
      const id = event instanceof CustomEvent ? objectValue(event.detail).id : undefined
      if (typeof id !== 'string' || !id) return
      void invoke('desktop_browser_close', { tabId: id }).catch(() => {})
    }
    window.addEventListener('xharness:browser-close', onCloseTab)
    let unlisten: NativeUnlisten | null = null
    let disposed = false
    native.event.listen('xharness-browser-event', event => {
      const payload = browserPayload(event.payload)
      if (payload?.kind === 'popup') window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { kind: 'browser', fresh: true, url: payload.value } }))
    }).then(fn => { if (disposed) fn(); else unlisten = fn }).catch(() => {})
    return () => { disposed = true; unlisten?.(); window.removeEventListener('xharness:browser-close', onCloseTab) }
  }, 'xharness-ui-browser: close native tabs')
  ctx.effect(() => {
    if (document.getElementById(STYLE_ID)) return () => {}
    const style = document.createElement('style')
    style.id = STYLE_ID; style.textContent = CSS; document.head.append(style)
    return () => style.remove()
  }, 'xharness-ui-browser: styles')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'browser-toggle', order: 100,
  }, BrowserToggle))
  ctx.slots.inject('workspace.item', () => ctx.slots.register({
    name: 'workspace.item', id: 'browser-pane', order: 40,
  }, (props: BrowserPaneProps) => props.item?.kind === 'browser' ? h(BrowserPane, props) : null))
}
