import type {} from '../modules/shared/tauri'
import { DESKTOP_TITLEBAR_CONTROLS_ID, DESKTOP_TITLEBAR_READY_EVENT } from '../modules/shared/desktop-titlebar'
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
    const drag = document.createElement('div')
    drag.id = 'xh-desktop-titlebar-drag'
    drag.setAttribute('data-tauri-drag-region', '')
    drag.setAttribute('aria-hidden', 'true')
    bar.appendChild(drag)
    const controls = document.createElement('div')
    controls.id = DESKTOP_TITLEBAR_CONTROLS_ID
    bar.appendChild(controls)
    document.body.prepend(bar)
    // React may hydrate before or after this deferred script. Publish the
    // mount once; the sidebar also reads the seat at its own mount boundary.
    window.dispatchEvent(new Event(DESKTOP_TITLEBAR_READY_EVENT))
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
})()
