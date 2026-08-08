/** A decorative, mouse-transparent exit after the real UI commits.
 * The renderer never waits for this animation and owns no loading-page DOM. */
export class StartupHandoff {
  private readonly root: HTMLElement
  private readonly mark: HTMLImageElement | null
  private readonly copy: HTMLElement | null
  private animations: Animation[] = []
  private started = false
  private disposed = false
  private readonly onHidden = (): void => { if (document.hidden) this.dispose() }
  private readonly onPageHide = (): void => { this.dispose() }
  private readonly onResize = (): void => { this.dispose() }

  constructor(surface: HTMLElement, private readonly container: HTMLElement) {
    const snapshot = surface.cloneNode(true)
    if (!(snapshot instanceof HTMLElement)) throw new Error('startup: invalid loading snapshot')
    this.root = snapshot
    this.root.dataset.xhStartupExit = ''
    this.root.dataset.motion = 'idle'
    this.root.setAttribute('aria-hidden', 'true')
    this.root.inert = true
    // The application can install its theme during commit. Keep the exit's
    // colors identical to the actual loading page, not that later theme.
    const colors = getComputedStyle(surface)
    this.root.style.backgroundColor = colors.backgroundColor
    this.root.style.color = colors.color
    this.mark = this.root.querySelector('img')
    this.copy = this.root.querySelector('.xh-startup-copy')
    const originalMessage = surface.querySelector('.xh-startup-message')
    const message = this.root.querySelector<HTMLElement>('.xh-startup-message')
    if (originalMessage !== null && message !== null) message.style.color = getComputedStyle(originalMessage).color
    this.root.removeAttribute('id')
    this.root.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
  }

  /** Called by the renderer's commit callback, never by Host Ready. */
  play(): void {
    if (this.started || this.disposed) return
    this.started = true
    const bounds = this.container.getBoundingClientRect()
    if (!this.container.isConnected || bounds.width <= 0 || bounds.height <= 0 || document.hidden
      || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
      || this.mark === null || typeof this.root.animate !== 'function' || typeof this.mark.animate !== 'function') {
      this.dispose()
      return
    }
    this.root.style.left = `${bounds.left}px`
    this.root.style.top = `${bounds.top}px`
    this.root.style.width = `${bounds.width}px`
    this.root.style.height = `${bounds.height}px`
    document.body.append(this.root)
    document.addEventListener('visibilitychange', this.onHidden)
    window.addEventListener('pagehide', this.onPageHide)
    window.addEventListener('resize', this.onResize)
    try {
      // Echo the entrance's contraction with a small, centered expansion.
      // No translation, full-screen zoom or wait before the UI becomes usable.
      this.animations.push(this.mark.animate([
        { transform: 'scale(1)', filter: 'brightness(1)' },
        { transform: 'scale(1.18)', filter: 'brightness(1.14)' },
      ], { duration: 180, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'both' }))
      this.animations.push(this.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'both' }))
      if (this.copy !== null) this.animations.push(this.copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'both' }))
      void Promise.all(this.animations.map(animation => animation.finished)).then(() => this.dispose(), () => this.dispose())
    } catch {
      // Motion is optional. A partial/unsupported animation cannot fail boot.
      this.dispose()
    }
  }

  /** Cancel on teardown/hidden/resize, including a prepared but unplayed exit. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const animation of this.animations) animation.cancel()
    this.animations = []
    this.root.remove()
    document.removeEventListener('visibilitychange', this.onHidden)
    window.removeEventListener('pagehide', this.onPageHide)
    window.removeEventListener('resize', this.onResize)
  }
}
