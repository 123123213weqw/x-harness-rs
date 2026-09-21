// Desktop-only final-UI startup milestones. The normal browser UI has no
// Tauri bridge and exits without observers or global state.
(() => {
  const invoke = window.__TAURI__?.core?.invoke
  if (typeof invoke !== 'function') return

  let hydrated = false
  let painted = false
  let observer

  const report = phase => {
    // Telemetry must never hold up or fail application startup.
    Promise.resolve(invoke('desktop_report_startup_phase', { phase })).catch(() => {})
  }

  const afterFirstPaint = () => {
    if (painted) return
    painted = true
    requestAnimationFrame(() => requestAnimationFrame(() => report('first_frame')))
  }

  const inspect = () => {
    if (hydrated) return
    const root = document.querySelector('#root')
    if (!root || root.childElementCount === 0) return
    hydrated = true
    observer?.disconnect()
    report('frontend_hydrated')
    afterFirstPaint()
  }

  const begin = () => {
    inspect()
    if (hydrated) return
    const root = document.querySelector('#root')
    if (!root) return
    observer = new MutationObserver(inspect)
    observer.observe(root, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', begin, { once: true })
  } else {
    begin()
  }
})()
