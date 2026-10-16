import type { NativeWindow } from '../modules/shared/tauri'

/** Mirror the resolved UI choice; System releases native override, never saving preferences. */
export function syncNativeTheme(native: Pick<NativeWindow, 'setTheme'>): void {
  const html = document.documentElement
  if (html.dataset.xhNativeThemeSync !== undefined) return
  html.dataset.xhNativeThemeSync = 'active'
  let desired: 'light' | 'dark' | null | undefined
  let attempted: 'light' | 'dark' | null | undefined
  let running = false
  let disposed = false
  async function apply(): Promise<void> {
    if (running) return
    running = true
    try {
      while (!disposed && desired !== undefined && desired !== attempted) {
        const scheme = desired
        // Serialize native writes so a slow old request cannot win over the
        // newest appearance. Failed requests never spin or block the UI.
        attempted = scheme
        try { await native.setTheme(scheme) }
        catch { console.warn('XHarness: native window theme could not be synchronized') }
      }
    } finally { running = false }
  }
  function changed(): void {
    const scheme = html.style.colorScheme
    if (html.dataset.xhThemePreference === 'system') desired = null
    else if (scheme === 'light' || scheme === 'dark') desired = scheme
    else if (scheme === '' && desired !== undefined) desired = null // presenter released ownership
    else return
    void apply()
  }
  const observer = new MutationObserver(changed)
  observer.observe(html, { attributes: true, attributeFilter: ['style', 'data-xh-theme-preference'] })
  function dispose(): void {
    disposed = true
    observer.disconnect()
    delete html.dataset.xhNativeThemeSync
    window.removeEventListener('pagehide', dispose)
  }
  window.addEventListener('pagehide', dispose, { once: true })
  changed()
}
