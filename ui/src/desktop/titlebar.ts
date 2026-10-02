import type {} from '../modules/shared/tauri'
// The web UI is also served to ordinary browsers. Only the macOS Tauri
// window has an overlay title bar and needs a draggable safe area.
(() => {
  if (typeof window.__TAURI__?.core?.invoke !== 'function') return
  if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return

  document.documentElement.dataset.xhMacTitlebar = 'overlay'

  const mount = () => {
    if (document.getElementById('xh-desktop-titlebar')) return
    const bar = document.createElement('div')
    bar.id = 'xh-desktop-titlebar'
    bar.setAttribute('aria-hidden', 'true')
    const drag = document.createElement('div')
    drag.id = 'xh-desktop-titlebar-drag'
    drag.setAttribute('data-tauri-drag-region', '')
    bar.appendChild(drag)
    document.body.prepend(bar)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
})()
