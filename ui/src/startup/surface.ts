/// <reference path="../modules/shared/assets.d.ts" />
import css from './surface.raw.css'
import mark from './mark.svg'
import { StartupHandoff } from './handoff'

/** Framework-free loading surface shared by the local shell and Web boot. */
export class StartupSurface {
  readonly root: HTMLDivElement
  private readonly image: HTMLImageElement
  private readonly copy: HTMLDivElement
  private readonly message: HTMLParagraphElement
  private readonly report: HTMLDivElement
  private animations: Animation[] = []
  private stopped = false
  private failed = false
  private handoff: StartupHandoff | undefined
  private readonly onHidden = (): void => { if (document.hidden) this.finish() }
  private readonly onPageHide = (): void => { this.finish() }

  constructor(container: HTMLElement, options: { message: string; intro: boolean }) {
    if (document.getElementById('xh-startup-style') === null) {
      const style = document.createElement('style')
      style.id = 'xh-startup-style'
      style.textContent = css
      document.head.append(style)
    }
    this.root = document.createElement('div')
    this.root.dataset.xhStartup = ''
    this.root.dataset.motion = 'idle'
    const cluster = document.createElement('div')
    cluster.className = 'xh-startup-cluster'
    this.image = document.createElement('img')
    this.image.className = 'xh-startup-mark'
    this.image.alt = ''
    this.image.draggable = false
    this.image.src = `data:image/svg+xml,${encodeURIComponent(mark)}`
    if (options.intro && !document.hidden && typeof this.image.animate === 'function') this.root.dataset.motion = 'pending'
    this.copy = document.createElement('div')
    this.copy.className = 'xh-startup-copy'
    const title = document.createElement('h1')
    title.textContent = 'XHarness'
    this.message = document.createElement('p')
    this.message.className = 'xh-startup-message'
    this.message.setAttribute('role', 'status')
    this.message.setAttribute('aria-live', 'polite')
    this.message.textContent = options.message
    this.report = document.createElement('div')
    this.report.className = 'xh-startup-report'
    this.report.setAttribute('role', 'alert')
    this.report.hidden = true
    this.copy.append(title, this.message, this.report)
    cluster.append(this.image, this.copy)
    this.root.append(cluster)
    container.append(this.root)
    if (options.intro) {
      document.addEventListener('visibilitychange', this.onHidden)
      window.addEventListener('pagehide', this.onPageHide)
      // Decoding may finish after failure, navigation or a very fast UI mount.
      // Never resurrect motion on a detached/completed loading page.
      const decoded = typeof this.image.decode === 'function' ? this.image.decode() : Promise.resolve()
      void decoded.catch(() => {}).then(() => {
        if (!this.stopped && this.root.isConnected && !document.hidden) this.play()
        else this.finish()
      })
    }
  }

  /** A live specific failure takes precedence over generic transport errors. */
  get hasFailed(): boolean { return this.failed }

  /** Native phases may update the message, but never overwrite a failure. */
  setMessage(message: string): void {
    if (!this.failed) this.message.textContent = message
  }

  /** A loader fiber may recover before boot fails; restore its original ABI.
   * No entrance is replayed after a transient plugin failure. */
  resetLoading(message: string): void {
    this.failed = false
    delete this.root.dataset.failed
    this.report.hidden = true
    this.report.replaceChildren()
    this.message.textContent = message
  }

  /** Activation counts are diagnostic data, not overall startup percentages. */
  setProgress(active: number, total: number): void {
    this.root.dataset.loaded = String(active)
    this.root.dataset.total = String(total)
  }

  /** Failure is terminal for this surface and cancels motion immediately. */
  fail(title: string, details: readonly string[] = []): void {
    this.finish()
    this.handoff?.dispose()
    this.handoff = undefined
    this.failed = true
    this.root.dataset.failed = ''
    this.message.textContent = title
    this.report.replaceChildren()
    for (const detail of details) {
      const row = document.createElement('div')
      row.textContent = detail
      this.report.append(row)
    }
    this.report.hidden = details.length === 0
  }

  /** Cancel without delaying renderer handoff or changing the loading DOM. */
  finish(): void {
    this.stopped = true
    for (const animation of this.animations) animation.cancel()
    this.animations = []
    this.root.dataset.motion = 'idle'
    document.removeEventListener('visibilitychange', this.onHidden)
    window.removeEventListener('pagehide', this.onPageHide)
  }

  /** Freeze before hydration; keep only this small snapshot, never the app. */
  prepareHandoff(container: HTMLElement): void {
    this.finish()
    this.handoff?.dispose()
    this.handoff = undefined
    if (!this.failed && this.root.isConnected) {
      try { this.handoff = new StartupHandoff(this.root, container) } catch { /* Optional decoration cannot fail boot. */ }
    }
  }

  /** The application is committed and clickable; the exit is purely visual. */
  completeHandoff(): void { if (!this.failed) this.handoff?.play() }

  dispose(): void { this.finish(); this.handoff?.dispose(); this.handoff = undefined; this.root.remove() }

  private play(): void {
    if (typeof this.image.animate !== 'function') { this.finish(); return }
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    this.root.dataset.motion = 'playing'
    const duration = reduced ? 120 : 480
    this.animations = [
      this.image.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [
        { offset: 0, transform: 'scale(5)', filter: 'brightness(1)', easing: 'cubic-bezier(.18,.8,.2,1)' },
        { offset: .82, transform: 'scale(1)', filter: 'brightness(1.42)', easing: 'ease-out' },
        { offset: 1, transform: 'scale(1)', filter: 'brightness(1)' },
      ], { duration, fill: 'both' }),
      this.copy.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [
        { offset: 0, opacity: 0 }, { offset: .58, opacity: 0 }, { offset: 1, opacity: 1 },
      ], { duration, fill: 'both' }),
    ]
    void Promise.all(this.animations.map(animation => animation.finished)).then(() => { this.finish() }).catch(() => {})
  }
}
