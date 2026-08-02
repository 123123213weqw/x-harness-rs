import type { NativeUnlisten } from '../modules/shared/tauri'
import { StartupSurface } from '../startup/surface'

/** Local/offline bootstrap. It never fetches the Host or client plugin assets. */
(() => {
  const container = document.getElementById('state')
  if (container === null) return
  const surface = new StartupSurface(container, { message: '正在初始化桌面运行环境…', intro: true })
  let disposed = false
  let unlisten: NativeUnlisten | undefined
  window.addEventListener('pagehide', () => {
    disposed = true
    surface.finish()
    unlisten?.()
  }, { once: true })
  const native = window.__TAURI__
  if (native === undefined) return
  async function boot(): Promise<void> {
    if (native === undefined) return
    const stop = await native.event.listen('xharness-bootstrap', ({ payload }) => {
      if (disposed || typeof payload !== 'object' || payload === null) return
      const message = 'message' in payload && typeof payload.message === 'string' ? payload.message : undefined
      const phase = 'phase' in payload ? payload.phase : undefined
      if (phase === 'failed') surface.fail(message ?? '桌面启动失败')
      else if (phase === 'ready') surface.setMessage('正在加载界面…')
      else if (message !== undefined) surface.setMessage(message)
    })
    if (disposed) { stop(); return }
    unlisten = stop
    // Subscribe before snapshot: an error emitted before DOM boot still appears.
    const status = await native.core.invoke('desktop_status')
    if (disposed) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!disposed) void native.core.invoke('desktop_report_startup_phase', { phase: 'window_mapped' }).catch(() => {})
    }))
    if (typeof status === 'object' && status !== null && 'startupError' in status && typeof status.startupError === 'string' && status.startupError.length > 0) {
      surface.fail(status.startupError)
    }
  }
  void boot().catch(() => {
    if (!disposed && !surface.hasFailed) surface.fail('无法读取桌面启动状态，请关闭此窗口后重试。')
  })
})()
