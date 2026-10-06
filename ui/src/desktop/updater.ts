import type { NativeInvoke, NativeUnlisten } from '../modules/shared/tauri'
import { isObjectRecord } from '../modules/shared/runtime-types'
type UpdateAction = 'check' | 'download' | 'install'
interface UpdateState extends Record<string, unknown> {
  seq: number
  phase?: string | undefined
  version?: string | null | undefined
  message?: string | null | undefined
  notes?: string | null | undefined
  retryAction?: UpdateAction | undefined
  downloaded?: number | undefined
  total?: number | null | undefined
}
interface UpdateView {label: string; action: string; busy: boolean; emphasized: boolean}
type Placement = 'current' | 'user'
interface InstallPlan {needsChoice: boolean; currentDirectory?: string | undefined; userDirectory?: string | undefined; migrationAvailable?: boolean | undefined; reason?: string | null | undefined}
interface UpdatePending {pending: boolean; confirming: boolean; plan?: InstallPlan | undefined; placement?: Placement | undefined}
function decodePlan(value: unknown): InstallPlan {
  if (!isObjectRecord(value) || typeof value.needsChoice !== 'boolean') throw Error('Invalid installation permission reply')
  if (value.needsChoice && (typeof value.currentDirectory !== 'string' || typeof value.userDirectory !== 'string' || typeof value.migrationAvailable !== 'boolean')) throw Error('Incomplete installation permission reply')
  if (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string') throw Error('Invalid installation permission reason')
  return {needsChoice: value.needsChoice, currentDirectory: typeof value.currentDirectory === 'string' ? value.currentDirectory : undefined,
    userDirectory: typeof value.userDirectory === 'string' ? value.userDirectory : undefined,
    migrationAvailable: typeof value.migrationAvailable === 'boolean' ? value.migrationAvailable : undefined,
    reason: nullableText(value.reason)}
}
function updateAction(value: unknown): value is UpdateAction {
  return value === 'check' || value === 'download' || value === 'install'
}
function nullableText(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined
}
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
/** Host snapshots are unknown until validated. Added fields remain forward-compatible. */
function decodeState(value: unknown): UpdateState | undefined {
  if (!isObjectRecord(value) || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq)) return
  if (value.phase !== undefined && typeof value.phase !== 'string') return
  for (const key of ['version', 'message', 'notes']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') return
  }
  if (value.retryAction !== undefined && value.retryAction !== null && !updateAction(value.retryAction)) return
  if (value.downloaded !== undefined && finiteNumber(value.downloaded) === undefined) return
  if (value.total !== undefined && value.total !== null && finiteNumber(value.total) === undefined) return
  return {...value, seq: value.seq, phase: value.phase,
    version: nullableText(value.version), message: nullableText(value.message), notes: nullableText(value.notes),
    retryAction: updateAction(value.retryAction) ? value.retryAction : undefined,
    downloaded: finiteNumber(value.downloaded), total: value.total === null ? null : finiteNumber(value.total)}
}
(() => {
  const busyPhases = new Set(['checking', 'downloading', 'stopping-host', 'host-force-stopped', 'installing', 'recovering-host', 'installed'])
  function updateView(state: Partial<UpdateState>): UpdateView {
    const phase = state.phase ?? 'idle'
    const view = { label: 'XHarness 桌面更新', action: '检查更新', busy: busyPhases.has(phase), emphasized: false }
    if (phase === 'available') return { ...view, label: '发现 XHarness ' + (state.version ?? '新版本'), action: '下载更新', emphasized: true }
    if (phase === 'checking') return { ...view, label: '正在检查更新…', action: '检查中' }
    if (phase === 'downloading') {
      const percent = typeof state.total === 'number' && state.total > 0 ? ' ' + Math.max(0, Math.min(100, Math.round(((state.downloaded ?? 0) / state.total) * 100))) + '%' : ''
      return { ...view, label: '正在下载更新' + percent, action: '下载中', emphasized: true }
    }
    if (phase === 'downloaded') return { ...view, label: '更新已下载并验证，可稍后重启', action: '重启更新', emphasized: true }
    if (view.busy) return { ...view, label: state.message ?? (phase === 'installed' ? '更新完成，正在重启…' : '正在安全安装更新…'), action: '安装中', emphasized: true }
    if (phase === 'error') return { ...view, label: state.message ?? '更新失败，请重试', action: '重试' }
    if (phase === 'up-to-date') return { ...view, label: 'XHarness 已是最新版本', action: '再次检查' }
    return view
  }

  // Controller is independent of DOM/Tauri: test real command routing, reloads,
  // out-of-order events, confirmation and double-clicks without a native window.
  function createController(invoke: NativeInvoke, changed: (state: UpdateState, pending: UpdatePending) => void = () => {}, options: {preflight?: boolean} = {}) {
    let state: UpdateState = { seq: -1, phase: 'idle' }
    let pending = false
    let confirming = false
    let disposed = false
    let automaticAttempts = 0
    let plan: InstallPlan | undefined
    let placement: Placement | undefined
    let preparation = 0
    function resetConsent() { confirming = false; plan = undefined; placement = undefined; preparation++ }
    function notify() { changed(state, { pending, confirming, plan, placement }) }
    async function prepareInstall() {
      if (disposed || pending || busyPhases.has(state.phase ?? '')) return
      if (!options.preflight) { confirming = true; notify(); return }
      resetConsent()
      pending = true
      const generation = preparation, before = state.seq
      notify()
      try {
        const reply = decodePlan(await invoke('desktop_update_preflight'))
        if (disposed || generation !== preparation || state.seq !== before) return
        plan = reply
        confirming = !reply.needsChoice
      } catch (error) {
        if (!disposed && generation === preparation && state.seq === before)
          state = {...state, phase: 'error', retryAction: 'install', message: String(error)}
      } finally { pending = false; notify() }
    }
    function accept(value: unknown) {
      const next = decodeState(value)
      if (!next || next.seq < state.seq) return
      if (busyPhases.has(next.phase ?? '') || (next.seq !== state.seq && (confirming || plan))) resetConsent()
      state = next
      notify()
    }
    async function execute(action: UpdateAction) {
      if (disposed || pending || busyPhases.has(state.phase ?? '')) return
      const installPlacement = placement
      pending = true
      resetConsent()
      const before = state.seq
      notify()
      try {
        const command = { check: 'desktop_check_update', download: 'desktop_download_update', install: 'desktop_install_update' }[action]
        accept(await invoke(command, action === 'install' ? { confirmStop: true, ...(installPlacement ? {placement: installPlacement} : {}) } : undefined))
      } catch (error) {
        // Rust owns the authoritative snapshot, including which operation failed.
        try { accept(await invoke('desktop_update_status')) } catch { /* bridge lost */ }
        if (state.seq <= before && !busyPhases.has(state.phase ?? '')) {
          state = { ...state, phase: 'error', retryAction: action, message: String(error) }
        }
      } finally {
        pending = false
        notify()
      }
    }
    return {
      get state() { return state },
      get confirming() { return confirming },
      get plan() { return plan },
      enablePreflight() { options.preflight = true },
      choose(value: Placement) {
        if (disposed || pending || !plan?.needsChoice || confirming || (value === 'user' && !plan.migrationAvailable)) return
        if (value !== 'user' && value !== 'current') return
        placement = value; confirming = true; notify()
      },
      get retryDelay() {
        if (disposed || pending || confirming || plan || state.phase !== 'error' || state.retryAction === 'install') return
        return [30_000, 120_000, 600_000][automaticAttempts - 1]
      },
      accept,
      async restore() { accept(await invoke('desktop_update_status')) },
      async prepare() {
        // Background preparation can only check/download. Never infer installation
        // consent from a timer, an online event, a restored cache or a UI reload.
        if (disposed || pending || confirming || plan || busyPhases.has(state.phase ?? '') || automaticAttempts >= 4) return
        if (state.phase === 'downloaded' || (state.phase === 'error' && state.retryAction === 'install')) return
        automaticAttempts++
        if (state.phase !== 'available' && !(state.phase === 'error' && state.retryAction === 'download')) await execute('check')
        if (disposed) return
        if (state.phase === 'available' || (state.phase === 'error' && state.retryAction === 'download')) await execute('download')
        if (state.phase === 'downloaded' || state.phase === 'up-to-date') automaticAttempts = 0
        notify()
      },
      dispose() { disposed = true; resetConsent() },
      check() {
        // Never replace a verified download or accidentally erase an install error.
        if (['idle', 'up-to-date', 'available'].includes(state.phase ?? '') || (state.phase === 'error' && state.retryAction === 'check')) return execute('check')
      },
      act() {
        automaticAttempts = 0
        if (pending || busyPhases.has(state.phase ?? '')) return
        const action = state.phase === 'error' ? (state.retryAction ?? 'check')
          : state.phase === 'downloaded' ? 'install' : state.phase === 'available' ? 'download' : 'check'
        if (action === 'install') return prepareInstall()
        return execute(action)
      },
      confirm() { if (confirming) return execute('install') },
      dismiss() { resetConsent(); notify() },
    }
  }

  window.__XHARNESS_DESKTOP_UPDATER_TEST__ = { updateView, createController }
  const invoke = window.__TAURI__?.core?.invoke
  const listen = window.__TAURI__?.event?.listen
  if (typeof invoke !== 'function' || typeof listen !== 'function' || typeof document === 'undefined' || !document.body) return

  let expanded = false
  let disposed = false
  let retryTimer: number | undefined
  let scheduledRetry: string | undefined
  let bootError: string | null = null
  const host = document.createElement('div')
  host.id = 'xharness-desktop-updater'
  host.hidden = true
  // Transitional fallback before the sidebar mounts. Once mounted, its reserved
  // footer row owns the position instead of a fixed offset competing with Tasks.
  // App chrome / local drawer (0–10) < updater (11) < shell overlays (20).
  // `auto` lets the sticky composer (7) paint over the expanded panel. Do not
  // promote this to the top layer: settings, approvals and menus must still win.
  host.style.cssText = 'position:fixed;left:11px;bottom:104px;z-index:11'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      :host{color-scheme:light dark} *{box-sizing:border-box}
      .panel{position:absolute;bottom:46px;left:0;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 166px);overflow:auto;padding:16px;border-radius:16px;
        background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);
        box-shadow:0 12px 40px #0003;font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
      [hidden]{display:none!important}.header{display:flex;justify-content:space-between;align-items:center;gap:8px}
      .title{font-size:14px;font-weight:650}.text{margin:12px 0;overflow-wrap:anywhere}
      .notes{max-height:160px;overflow:auto;white-space:pre-wrap;font:inherit;border-top:1px solid #8883;padding-top:10px}
      .footer{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.hint{opacity:.65;font-size:12px;margin-top:10px}
      button{appearance:none;border:0;border-radius:9px;padding:8px 12px;font:inherit;cursor:pointer;background:color-mix(in srgb,CanvasText 8%,Canvas);color:CanvasText}
      button:hover{filter:brightness(.93)}button:focus-visible{outline:2px solid #3974ff;outline-offset:3px}
      button:disabled{cursor:wait;opacity:.65}.primary{background:#2463eb;color:white}
      .toggle{position:relative;width:34px;height:34px;padding:8px;display:grid;place-items:center;border-radius:10px;background:Canvas;color:CanvasText;border:1px solid #8883}
      .toggle.primary{background:#2463eb;color:white;border-color:transparent;box-shadow:0 3px 12px #2463eb33}
      .toggle svg{width:18px;height:18px}.close{font-size:18px;line-height:1;padding:4px 8px;background:transparent}
      progress{width:100%;height:6px;accent-color:#2463eb}.confirm{margin-top:12px;padding:10px;border:1px solid #d99b3444;border-radius:8px}
      @media(prefers-reduced-motion:no-preference){.busy svg{animation:pulse 1.5s ease-in-out infinite}@keyframes pulse{50%{opacity:.45}}}
    </style>
    <section class="panel" hidden role="dialog" aria-modal="false" aria-label="XHarness 软件更新">
      <div class="header"><span class="title">XHarness 更新</span><button class="close" aria-label="关闭更新面板">×</button></div>
      <div class="text" role="status" aria-live="polite"></div>
      <progress hidden aria-label="更新下载进度"></progress>
      <pre class="notes" hidden></pre>
      <div class="placement" hidden></div>
      <div class="confirm" hidden>重启将停止当前 Agent、工具和后台 Job。会话会保存，但运行中的命令不保证自动恢复。确认现在更新？</div>
      <div class="footer"><button class="later" hidden>稍后</button><button class="current-place" hidden></button><button class="action primary">检查更新</button></div>
      <div class="hint">下载不影响当前工作；安装需要重启应用。</div>
      <div class="footer"><button class="diagnostics">运行诊断</button></div>
    </section>
    <button class="toggle" aria-label="检查 XHarness 更新" aria-expanded="false" title="XHarness 更新">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></svg>
    </button>`
  document.body.append(host)
  const $ = (selector: string): HTMLElement => {
    const node = root.querySelector(selector)
    if (!(node instanceof HTMLElement)) throw Error('desktop updater: missing element ' + selector)
    return node
  }
  const progressElement = (): HTMLProgressElement => {
    const node = root.querySelector('progress')
    if (!(node instanceof HTMLProgressElement)) throw Error('desktop updater: missing progress')
    return node
  }
  $('.diagnostics').addEventListener('click', async () => {
    try { await invoke('desktop_open_diagnostics') } catch { $('.hint').textContent = '无法打开运行诊断，请重启客户端后再试。' }
  })
  const panel = $('.panel'), toggle = $('.toggle'), action = root.querySelector('.action')
  if (!(action instanceof HTMLButtonElement)) throw Error('desktop updater: missing action button')
  const text = $('.text'), notes = $('.notes'), progress = progressElement(), confirmation = $('.confirm'), later = $('.later')
  let anchorSlot: HTMLElement | null = null
  let anchorStarted = false
  let anchorFrame: number | undefined
  // ResizeObserver delivery must not mutate another observed box in the same
  // layout cycle (WebKit reports an undelivered-notifications loop otherwise).
  function scheduleAnchor() {
    if (disposed || anchorFrame !== undefined) return
    anchorFrame = window.requestAnimationFrame(() => {
      anchorFrame = undefined
      if (!disposed) positionAnchor()
    })
  }
  const anchorSize = new ResizeObserver(scheduleAnchor)
  const anchorMount = new MutationObserver(() => {
    // Streaming message mutations must not cause repeated layout reads.
    if (!anchorSlot?.isConnected) scheduleAnchor()
  })
  function positionAnchor() {
    const nextSlot = document.getElementById('xharness-sidebar-updater-slot')
    if (nextSlot !== anchorSlot) {
      anchorSize.disconnect()
      if (anchorSlot) anchorSlot.hidden = true
      anchorSlot = nextSlot
      if (anchorSlot) {
        anchorSlot.style.cssText = 'height:42px;flex:none;width:100%'
        anchorSlot.hidden = false
        anchorSize.observe(anchorSlot)
        if (anchorSlot.parentElement) anchorSize.observe(anchorSlot.parentElement)
      }
    }
    if (anchorSlot) {
      const rect = anchorSlot.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const left = Math.max(0, Math.min(rect.left + 1, window.innerWidth - 34))
        const top = Math.max(0, Math.min(rect.top + 4, window.innerHeight - 34))
        host.style.left = left + 'px'
        host.style.top = top + 'px'
        host.style.bottom = 'auto'
        // Bottom of panel = toggle top - 12px; keep a 16px top inset.
        panel.style.maxHeight = Math.max(0, top - 28) + 'px'
        return
      }
    }
    host.style.left = '11px'
    host.style.top = 'auto'
    host.style.bottom = '104px'
    panel.style.maxHeight = 'calc(100vh - 166px)'
  }
  function showAnchor() {
    if (!anchorStarted) {
      anchorStarted = true
      anchorMount.observe(document.body, { childList: true, subtree: true })
      window.addEventListener('resize', positionAnchor)
    }
    host.hidden = false
    positionAnchor()
  }
  const tr = (zh: string, en: string) => (document.documentElement.lang || navigator.language || 'en').startsWith('zh') ? zh : en
  const placementBox = $('.placement'), currentPlace = root.querySelector('.current-place')
  if (!(currentPlace instanceof HTMLButtonElement)) throw Error('desktop updater: missing placement button')
  const controller = createController(invoke, (state, { pending, confirming, plan, placement }) => {
    const view = bootError
      ? { label: '桌面更新初始化失败：' + bootError, action: '更新不可用', busy: false, emphasized: false }
      : updateView(state)
    panel.hidden = !expanded
    toggle.classList.toggle('primary', view.emphasized)
    toggle.classList.toggle('busy', view.busy || pending)
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.setAttribute('aria-label', view.label)
    toggle.title = view.label
    text.textContent = view.label
    notes.textContent = state.notes ?? '' // Release text is untrusted: never innerHTML.
    notes.hidden = !notes.textContent
    const choosing = Boolean(plan?.needsChoice && !confirming)
    placementBox.hidden = !choosing
    placementBox.textContent = choosing ? [
      tr('旧安装位置需要权限确认，建议迁移到用户目录，后续更新无需管理员权限。', 'The current installation needs a permission decision. Move to your user directory for future non-admin updates.'),
      plan?.userDirectory ?? '',
      tr('会话与配置不变；旧安装不会自动删除。', 'Conversations and settings are preserved. The old installation will not be deleted.'),
      plan?.migrationAvailable ? '' : (plan?.reason ?? tr('暂不可迁移', 'Migration unavailable')),
    ].filter(Boolean).join('\n') : ''
    placementBox.style.whiteSpace = 'pre-wrap'
    placementBox.style.overflowWrap = 'anywhere'
    currentPlace.hidden = !choosing
    currentPlace.textContent = tr('保留原位置更新', 'Keep current location')
    currentPlace.disabled = pending || view.busy
    confirmation.textContent = (placement === 'user' ? tr('将迁移到用户目录。', 'Move to your user directory. ') : placement === 'current' ? tr('保留原位置，Windows 可能请求管理员确认。', 'Keep current location. Windows may request administrator approval. ') : '') +
      tr('重启将停止当前 Agent、工具和后台任务。会话会保存，运行中的命令不保证自动恢复。', 'Restart will stop running agents, tools and jobs. Conversations are saved; running commands may not resume.')
    action.textContent = choosing ? tr('迁移并更新（推荐）', 'Migrate & update (recommended)') : confirming ? tr('停止任务并重启更新', 'Stop tasks & update') : view.action
    action.disabled = Boolean(bootError) || pending || view.busy || (choosing && !plan?.migrationAvailable)
    confirmation.hidden = !confirming
    later.hidden = !confirming && !choosing
    later.textContent = tr('稍后', 'Later')
    progress.hidden = state.phase !== 'downloading'
    if (typeof state.total === 'number' && state.total > 0) { progress.max = state.total; progress.value = Math.min(state.downloaded ?? 0, state.total) }
    else progress.removeAttribute('value')
    const delay = controller.retryDelay
    // A disconnected IPC can produce a local error without advancing native seq.
    // Include the attempt's backoff, and cancel stale timers on success/consent.
    const retryKey = !disposed && delay !== undefined ? `${state.seq}:${state.retryAction}:${delay}` : undefined
    if (retryKey !== scheduledRetry) {
      window.clearTimeout(retryTimer)
      retryTimer = undefined
      scheduledRetry = retryKey
      if (retryKey !== undefined && delay !== undefined) retryTimer = window.setTimeout(() => { retryTimer = undefined; return prepare() }, delay)
    }
  })
  const prepare = () => {
    if (disposed || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
    return controller.prepare()
  }
  function collapse() { expanded = false; controller.dismiss() }
  toggle.addEventListener('click', () => { expanded = !expanded; controller.dismiss() })
  $('.close').addEventListener('click', collapse)
  later.addEventListener('click', () => controller.dismiss())
  currentPlace.addEventListener('click', () => controller.choose('current'))
  action.addEventListener('click', () => controller.confirming ? controller.confirm() : controller.plan?.needsChoice ? controller.choose('user') : controller.act())
  root.addEventListener('keydown', event => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      collapse()
      toggle.focus()
    }
  })

  let unlisten: NativeUnlisten | undefined, initialTimer: number | undefined, periodicTimer: number | undefined
  const online = () => { if (!disposed && document.visibilityState === 'visible') prepare() }
  window.addEventListener('online', online)
  window.addEventListener('pagehide', () => {
    disposed = true
    controller.dispose()
    anchorMount.disconnect()
    anchorSize.disconnect()
    if (anchorFrame !== undefined) window.cancelAnimationFrame(anchorFrame)
    window.removeEventListener('resize', positionAnchor)
    if (anchorSlot) anchorSlot.hidden = true
    unlisten?.()
    window.clearTimeout(initialTimer)
    window.clearInterval(periodicTimer)
    window.clearTimeout(retryTimer)
    window.removeEventListener('online', online)
  }, { once: true })
  const boot = async () => {
    const status = await invoke('desktop_status')
    if (!isObjectRecord(status) || typeof status.updaterConfigured !== 'boolean')
      throw Error('desktop updater: invalid desktop status')
    if (!status.updaterConfigured || disposed) return
    if (status.updatePreflightSupported === true) controller.enablePreflight()
    unlisten = await listen('xharness-update', ({ payload }) => controller.accept(payload))
    if (disposed) { unlisten(); return }
    await controller.restore()
    if (disposed) return
    showAnchor()
    // Silent preparation only lights up the icon; never expand over a conversation.
    initialTimer = window.setTimeout(prepare, 1500)
    periodicTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') prepare()
    }, 6 * 60 * 60 * 1000)
  }
  boot().catch((error: unknown) => {
    unlisten?.()
    if (disposed) { host.remove(); return }
    // Do not silently hide native ACL/configuration failures. Keep a quiet,
    // inspectable error badge; never offer installation on a broken bridge.
    bootError = String(error)
    showAnchor()
    controller.dismiss()
  })
})()

declare global {
  interface Window {
    __XHARNESS_DESKTOP_UPDATER_TEST__?: {
      updateView(state: Partial<UpdateState>): UpdateView
      createController(invoke: NativeInvoke, changed?: (state: UpdateState, pending: UpdatePending) => void, options?: {preflight?: boolean}): {
        readonly state: UpdateState; readonly confirming: boolean; readonly plan: InstallPlan | undefined;
        enablePreflight(): void; choose(value: Placement): void;
        accept(value: unknown): void; restore(): Promise<void>;
        check(): Promise<void> | undefined; act(): Promise<void> | undefined;
        confirm(): Promise<void> | undefined; dismiss(): void
      }
    }
  }
}
