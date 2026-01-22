(() => {
  const tauri = window.__TAURI__
  const invoke = tauri?.core?.invoke
  const listen = tauri?.event?.listen

  function updateView(state) {
    const phase = state.phase ?? 'idle'
    if (phase === 'available') {
      return {
        label: `发现 XHarness ${state.version ?? '新版本'}`,
        action: '下载并安装',
        busy: false,
        emphasized: true,
      }
    }
    if (phase === 'checking') {
      return { label: '正在检查更新…', action: '检查中', busy: true, emphasized: false }
    }
    if (phase === 'downloading') {
      const percent = state.total > 0
        ? ` ${Math.min(100, Math.round((state.downloaded / state.total) * 100))}%`
        : ''
      return {
        label: `正在下载更新${percent}`,
        action: '下载中',
        busy: true,
        emphasized: true,
      }
    }
    if (['verified', 'stopping-host', 'host-force-stopped', 'installing', 'recovering-host', 'installed'].includes(phase)) {
      return {
        label: state.message ?? (phase === 'installed' ? '更新完成，正在重启…' : '正在安全安装更新…'),
        action: '安装中',
        busy: true,
        emphasized: true,
      }
    }
    if (phase === 'error') {
      return { label: state.message ?? '更新失败，请重试', action: '重试', busy: false, emphasized: false }
    }
    if (phase === 'up-to-date') {
      return { label: 'XHarness 已是最新版本', action: '再次检查', busy: false, emphasized: false }
    }
    return { label: 'XHarness 桌面更新', action: '检查更新', busy: false, emphasized: false }
  }

  // Kept deliberately tiny and dependency-free: this bridge is loaded by the
  // product HTML, not by the upstream client-module graph. A broken optional
  // updater can therefore never prevent the conversation UI from booting.
  window.__XHARNESS_DESKTOP_UPDATER_TEST__ = { updateView }
  if (typeof invoke !== 'function' || typeof listen !== 'function' || !document?.body) return

  let state = { phase: 'idle' }
  let expanded = false
  let installing = false
  const host = document.createElement('div')
  host.id = 'xharness-desktop-updater'
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      *{box-sizing:border-box} .box{display:flex;align-items:center;gap:10px;max-width:360px;padding:8px;
      border:1px solid color-mix(in srgb, CanvasText 14%, transparent);border-radius:14px;background:Canvas;
      color:CanvasText;box-shadow:0 12px 36px #0003;font:13px/1.35 ui-sans-serif,system-ui,sans-serif}
      .message{display:none;min-width:150px;max-width:240px;padding-left:4px}.expanded .message{display:block}
      button{appearance:none;border:0;border-radius:10px;padding:8px 11px;background:color-mix(in srgb, CanvasText 8%, Canvas);
      color:CanvasText;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
      button:hover{background:color-mix(in srgb, CanvasText 14%, Canvas)}button:disabled{cursor:wait;opacity:.68}
      .primary{background:#1f5eff;color:white}.primary:hover{background:#174bd1}
      .toggle{width:34px;height:34px;padding:0;font-size:17px}.dot{display:inline-block;width:7px;height:7px;margin-right:6px;
      border-radius:99px;background:#1f5eff;vertical-align:1px}.busy .dot{animation:pulse 1s ease-in-out infinite}
      @keyframes pulse{50%{opacity:.25}}
      @media(max-width:600px){.box{max-width:calc(100vw - 28px)}.message{max-width:170px}}
    </style>
    <div class="box" role="status" aria-live="polite">
      <button class="toggle" type="button" title="XHarness 更新" aria-label="展开更新面板">↑</button>
      <span class="message"><span class="dot"></span><span class="text"></span></span>
      <button class="action" type="button"></button>
    </div>`
  document.body.append(host)
  const box = root.querySelector('.box')
  const text = root.querySelector('.text')
  const action = root.querySelector('.action')
  const toggle = root.querySelector('.toggle')

  function render() {
    const view = updateView(state)
    box.classList.toggle('expanded', expanded || state.phase !== 'idle')
    box.classList.toggle('busy', view.busy)
    action.classList.toggle('primary', view.emphasized)
    text.textContent = view.label
    action.textContent = view.action
    action.disabled = view.busy
    toggle.textContent = expanded ? '×' : (state.phase === 'available' ? '↑' : '↻')
  }

  async function check() {
    if (installing) return
    state = { phase: 'checking' }
    expanded = true
    render()
    try {
      const update = await invoke('desktop_check_update')
      state = update.available
        ? { phase: 'available', version: update.version, notes: update.notes }
        : { phase: 'up-to-date' }
    } catch (error) {
      state = { phase: 'error', message: String(error) }
    }
    render()
  }

  async function install() {
    if (installing) return
    installing = true
    state = { ...state, phase: 'downloading', downloaded: 0, total: 0 }
    render()
    try {
      await invoke('desktop_install_update')
    } catch (error) {
      installing = false
      state = { phase: 'error', message: String(error) }
      render()
    }
  }

  toggle.addEventListener('click', () => {
    expanded = !expanded
    render()
  })
  action.addEventListener('click', () => {
    if (state.phase === 'available') install()
    else check()
  })
  listen('xharness-update', ({ payload }) => {
    if (!payload?.phase) return
    state = { ...state, ...payload }
    expanded = true
    render()
  }).catch(() => {})

  invoke('desktop_status').then(status => {
    if (!status?.updaterConfigured) {
      host.remove()
      return
    }
    render()
    window.setTimeout(check, 1500)
  }).catch(() => host.remove())
})()
