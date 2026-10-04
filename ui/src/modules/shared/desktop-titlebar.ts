/** DOM seat owned by the native macOS title bar, not a second layout store. */
export const DESKTOP_TITLEBAR_CONTROLS_ID = 'xh-desktop-titlebar-controls'
export const DESKTOP_TITLEBAR_READY_EVENT = 'xh-desktop-titlebar-ready'

export function desktopTitlebarControls(): HTMLElement | null {
  if (typeof document === 'undefined' || document.documentElement.dataset.xhMacTitlebar !== 'overlay') return null
  return document.getElementById(DESKTOP_TITLEBAR_CONTROLS_ID)
}
