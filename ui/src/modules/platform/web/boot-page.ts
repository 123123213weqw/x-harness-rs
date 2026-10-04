/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @xharness/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status'
import css from './boot-page.module.css'
import type {} from '../../shared/tauri'
import { StartupSurface } from '../../../startup/surface'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly surface: StartupSurface
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    container.append(this.root)
    // The local desktop document already played the entrance. A browser has
    // no shell stage, so its BootPage owns the single entrance instead.
    this.surface = new StartupSurface(this.root, {
      message: '正在加载界面…', intro: typeof window.__TAURI__?.core?.invoke !== 'function',
    })
    this.updateProgress()
  }

  /**
   * Set the number of loader entries retained as diagnostic counts.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.surface.dispose()
    this.root.remove()
  }

  /** Stop motion/listeners before hydration snapshots the framework-free DOM. */
  finish(): void { this.surface.finish() }

  /** Capture before hydration removes this DOM; do not start an exit yet. */
  prepareHandoff(container: HTMLElement): void { this.surface.prepareHandoff(container) }

  /** Only the UI renderer's actual commit can reveal the decorative exit. */
  completeHandoff(): void { this.surface.completeHandoff() }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.surface.hasFailed) this.surface.resetLoading('正在加载界面…')
      return
    }
    this.surface.fail('Failed to load plugins', [...failed, ...(this.failure === undefined ? [] : [this.failure])])
  }

  /** Retain real loader counts without inventing an overall boot percentage. */
  private updateProgress(): void {
    this.surface.setProgress(this.active.size, this.total)
  }
}
