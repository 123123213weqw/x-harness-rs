(() => {
  const busyPhases = new Set(['checking', 'downloading', 'stopping-host', 'host-force-stopped', 'installing', 'recovering-host', 'installed'])
  function updateView(state) {
    const phase = state.phase ?? 'idle'
    const view = { label: 'XHarness 桌面更新', action: '检查更新', busy: busyPhases.has(phase), emphasized: false }
    if (phase === 'available') return { ...view, label: '发现 XHarness ' + (state.version ?? '新版本'), action: '下载更新', emphasized: true }
    if (phase === 'checking') return { ...view, label: '正在检查更新…', action: '检查中' }
    if (phase === 'downloading') {
      const percent = state.total > 0 ? ' ' + Math.max(0, Math.min(100, Math.round((state.downloaded / state.total) * 100))) + '%' : ''
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
  function createController(invoke, changed = () => {}) {
    let state = { seq: -1, phase: 'idle' }
    let pending = false
    let confirming = false
    function notify() { changed(state, { pending, confirming }) }
    function accept(next) {
      if (!next || !Number.isSafeInteger(next.seq) || next.seq < state.seq) return
      state = next
      if (busyPhases.has(state.phase)) confirming = false
      notify()
    }
    async function execute(action) {
      if (pending || busyPhases.has(state.phase)) return
      pending = true
      confirming = false
      const before = state.seq
      notify()
      try {
        const command = { check: 'desktop_check_update', download: 'desktop_download_update', install: 'desktop_install_update' }[action]
        accept(await invoke(command, action === 'install' ? { confirmStop: true } : undefined))
      } catch (error) {
        // Rust owns the authoritative snapshot, including which operation failed.
        try { accept(await invoke('desktop_update_status')) } catch { /* bridge lost */ }
        if (state.seq <= before && !busyPhases.has(state.phase)) {
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
      accept,
      async restore() { accept(await invoke('desktop_update_status')) },
      check() {
        // Never replace a verified download or accidentally erase an install error.
        if (['idle', 'up-to-date', 'available'].includes(state.phase) || (state.phase === 'error' && state.retryAction === 'check')) return execute('check')
      },
      act() {
        if (pending || busyPhases.has(state.phase)) return
        const action = state.phase === 'error' ? (state.retryAction ?? 'check')
          : state.phase === 'downloaded' ? 'install' : state.phase === 'available' ? 'download' : 'check'
        if (action === 'install') { confirming = true; notify(); return }
        return execute(action)
      },
      confirm() { if (confirming) return execute('install') },
      dismiss() { confirming = false; notify() },
    }
  }

  window.__XHARNESS_DESKTOP_UPDATER_TEST__ = { updateView, createController }
  const invoke = window.__TAURI__?.core?.invoke
  const listen = window.__TAURI__?.event?.listen
  if (typeof invoke !== 'function' || typeof listen !== 'function' || typeof document === 'undefined' || !document.body) return

  let expanded = false
  const host = document.createElement('div')
  host.id = 'xharness-desktop-updater'
  host.hidden = true
  // Keep the sidebar's bottom Settings button accessible in both rail and expanded layouts.
  host.style.cssText = 'position:fixed;left:11px;bottom:64px;z-index:2147483000'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      :host{color-scheme:light dark} *{box-sizing:border-box}
      .panel{position:absolute;bottom:46px;left:0;width:min(340px,calc(100vw - 32px));padding:16px;border-radius:16px;
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
    <section class="panel" hidden aria-label="XHarness 软件更新">
      <div class="header"><span class="title">XHarness 更新</span><button class="close" aria-label="关闭更新面板">×</button></div>
      <div class="text" role="status" aria-live="polite"></div>
      <progress hidden aria-label="更新下载进度"></progress>
      <pre class="notes" hidden></pre>
      <div class="confirm" hidden>重启将停止当前 Agent、工具和后台 Job。会话会保存，但运行中的命令不保证自动恢复。确认现在更新？</div>
      <div class="footer"><button class="later" hidden>稍后</button><button class="action primary">检查更新</button></div>
      <div class="hint">下载不影响当前工作；安装需要重启应用。</div>
    </section>
    <button class="toggle" aria-label="检查 XHarness 更新" aria-expanded="false" title="XHarness 更新">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></svg>
    </button>`
  document.body.append(host)
  const $ = selector => root.querySelector(selector)
  const panel = $('.panel'), toggle = $('.toggle'), action = $('.action')
  const text = $('.text'), notes = $('.notes'), progress = $('progress'), confirmation = $('.confirm'), later = $('.later')
  const controller = createController(invoke, (state, { pending, confirming }) => {
    const view = updateView(state)
    panel.hidden = !expanded
    toggle.classList.toggle('primary', view.emphasized)
    toggle.classList.toggle('busy', view.busy || pending)
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.setAttribute('aria-label', view.label)
    toggle.title = view.label
    text.textContent = view.label
    notes.textContent = state.notes ?? '' // Release text is untrusted: never innerHTML.
    notes.hidden = !notes.textContent
    action.textContent = confirming ? '停止任务并重启更新' : view.action
    action.disabled = pending || view.busy
    confirmation.hidden = !confirming
    later.hidden = !confirming
    progress.hidden = state.phase !== 'downloading'
    if (state.total > 0) { progress.max = state.total; progress.value = Math.min(state.downloaded, state.total) }
    else progress.removeAttribute('value')
  })
  function collapse() { expanded = false; controller.dismiss() }
  toggle.addEventListener('click', () => { expanded = !expanded; controller.dismiss() })
  $('.close').addEventListener('click', collapse)
  later.addEventListener('click', () => controller.dismiss())
  action.addEventListener('click', () => controller.confirming ? controller.confirm() : controller.act())
  root.addEventListener('keydown', event => { if (event.key === 'Escape') { collapse(); toggle.focus() } })

  let disposed = false
  let unlisten, initialTimer, periodicTimer
  window.addEventListener('pagehide', () => {
    disposed = true
    unlisten?.()
    window.clearTimeout(initialTimer)
    window.clearInterval(periodicTimer)
  }, { once: true })
  async function boot() {
    const status = await invoke('desktop_status')
    if (!status?.updaterConfigured || disposed) return
    unlisten = await listen('xharness-update', ({ payload }) => controller.accept(payload))
    if (disposed) { unlisten(); return }
    await controller.restore()
    if (disposed) return
    host.hidden = false
    // Silent checks only light up the icon; never expand a panel over a conversation.
    initialTimer = window.setTimeout(() => controller.check(), 1500)
    periodicTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') controller.check()
    }, 6 * 60 * 60 * 1000)
  }
  boot().catch(() => { unlisten?.(); host.remove() })
})()
