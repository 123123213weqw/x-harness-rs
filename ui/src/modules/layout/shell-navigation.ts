import { SHELL_ROUTE_CHANGED } from '../shared/shell-route'

/** Shell routes only: no transcript copies, browser history, or Agent commands. */
export type ShellPage = 'chat' | 'plugins' | 'work' | 'review' | 'assistant'
export interface ShellRoute { readonly page: ShellPage; readonly sessionId: string | undefined }
export interface ShellNavigationSnapshot {
  readonly route: ShellRoute
  readonly canBack: boolean
  readonly canForward: boolean
}
export interface ShellNavigationSessions {
  readonly list: {
    getSnapshot(): {
      readonly current: string | undefined
      readonly phase: 'pending' | 'ready'
      readonly ids: readonly string[]
      readonly byId: Readonly<Record<string, unknown>>
      readonly subagentsByParent?: Readonly<Record<string, {
        readonly entries: readonly { readonly id: string; readonly kind: string }[]
      }>>
    }
    subscribe(listener: () => void): () => void
  }
  open(id: string): void
  clear(): void
  subagentAddress(id: string): unknown
}
/** The sidebar receives commands + an observable, not session/runtime internals. */
export interface ShellNavigationControls {
  getSnapshot(): ShellNavigationSnapshot
  subscribe(listener: () => void): () => void
  back(): void
  forward(): void
}

const pages = ['plugins', 'work', 'review', 'assistant'] as const
const sameRoute = (a: ShellRoute, b: ShellRoute): boolean => a.page === b.page && a.sessionId === b.sessionId
export const SHELL_HISTORY_LIMIT = 128

/** One history owner for session selection and center-page transitions. History
 * is window-local and bounded; deleted routes are skipped, never recreated. */
export class ShellNavigation implements ShellNavigationControls {
  private entries: ShellRoute[] = []
  private position = -1
  private snapshot: ShellNavigationSnapshot = {
    route: { page: 'chat', sessionId: undefined }, canBack: false, canForward: false,
  }
  private readonly listeners = new Set<() => void>()
  private target: EventTarget | undefined
  private replaying = false
  private pendingPage: ShellPage | undefined
  private scheduled = false
  private generation = 0
  private initialized = false
  private selected: string | undefined

  constructor(private readonly sessions: ShellNavigationSessions) {}

  getSnapshot = (): ShellNavigationSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  back = (): void => { this.travel(-1) }
  forward = (): void => { this.travel(1) }
  close = (): void => { this.openPage('chat') }

  /** Owned by AppFrame's effect, with symmetric cleanup (also StrictMode safe). */
  mount(target: EventTarget): () => void {
    if (this.target) throw new Error('shell navigation: already mounted')
    this.target = target
    const bindings = pages.map(page => {
      const listener = (): void => { this.openPage(page) }
      target.addEventListener(`xharness:${page}:open`, listener)
      return () => target.removeEventListener(`xharness:${page}:open`, listener)
    })
    target.addEventListener('xharness:assistant:close', this.close)
    const off = this.sessions.list.subscribe(this.schedule)
    this.flush()
    this.present(this.snapshot.route.page)
    return () => {
      off()
      for (const remove of bindings) remove()
      target.removeEventListener('xharness:assistant:close', this.close)
      this.target = undefined
      this.generation++
      this.scheduled = false
      this.pendingPage = undefined
    }
  }

  private schedule = (): void => {
    if (this.replaying || this.scheduled || !this.target) return
    this.scheduled = true
    const generation = this.generation
    queueMicrotask(() => {
      if (generation !== this.generation) return
      this.scheduled = false
      this.flush()
    })
  }
  private flush(): void {
    const state = this.sessions.list.getSnapshot()
    if (state.phase !== 'ready') { this.publish(); return }
    // A list re-pull may temporarily mask a retained selection. It is not a
    // user visit to the empty page and must not cut off the forward branch.
    const masked = state.current === undefined && this.selected !== undefined && state.byId[this.selected] === undefined
    const sessionId = masked ? this.selected : state.current
    if (!this.initialized) {
      this.initialized = true
      this.selected = sessionId
      this.entries = [{ page: 'chat', sessionId }]
      this.position = 0
      this.publish()
    }
    const page = this.pendingPage ?? this.snapshot.route.page
    this.pendingPage = undefined
    this.selected = sessionId
    // Coalesce a feature's open event and its same-gesture session selection.
    // Returning to a page never replays that feature's open operation.
    this.visit({ page, sessionId })
    this.publish()
  }
  private openPage(page: ShellPage): void {
    if (!this.target) return
    this.pendingPage = page
    this.schedule()
  }
  private visit(route: ShellRoute): void {
    const previous = this.entries[this.position]
    if (previous && sameRoute(previous, route)) return
    this.entries = this.entries.slice(0, this.position + 1)
    this.entries.push(route)
    if (this.entries.length > SHELL_HISTORY_LIMIT) this.entries.shift()
    this.position = this.entries.length - 1
    this.publish()
    this.present(route.page)
  }

  private available(route: ShellRoute): boolean {
    const state = this.sessions.list.getSnapshot()
    if (state.phase !== 'ready') return false
    if (route.sessionId === undefined) return true
    if (state.ids.includes(route.sessionId)) return true
    // Catalog children are deliberately absent from ids after leaving them.
    // Retained addresses are enough while their catalog is not yet loaded;
    // a loaded catalog tombstone is authoritative and must not be reopened.
    const address = this.sessions.subagentAddress(route.sessionId)
    if (typeof address !== 'object' || address === null || !('parentSessionId' in address)
      || typeof address.parentSessionId !== 'string') return false
    const catalog = state.subagentsByParent?.[address.parentSessionId]
    return catalog === undefined || catalog.entries.some(entry => entry.id === route.sessionId && entry.kind === 'child')
  }
  private find(direction: -1 | 1): number {
    const current = this.entries[this.position]
    for (let i = this.position + direction; i >= 0 && i < this.entries.length; i += direction) {
      const route = this.entries[i]
      if (route && (!current || !sameRoute(route, current)) && this.available(route)) return i
    }
    return -1
  }
  private travel(direction: -1 | 1): void {
    if (!this.target) return
    this.flush()
    const next = this.find(direction)
    if (next === -1) return
    const route = this.entries[next]
    if (route === undefined) return
    this.replaying = true
    try {
      if (route.sessionId !== this.sessions.list.getSnapshot().current) {
        if (route.sessionId === undefined) this.sessions.clear()
        else this.sessions.open(route.sessionId)
      }
      // Selection is synchronous; never advance a cursor on an unaccepted
      // route. Transcript loading continues through the existing runtime.
      if (this.sessions.list.getSnapshot().current !== route.sessionId) return
      this.selected = route.sessionId
      this.position = next
      this.publish()
      this.present(route.page)
    } finally { this.replaying = false }
  }
  private publish(): void {
    const route = this.entries[this.position] ?? this.snapshot.route
    const canBack = this.find(-1) !== -1, canForward = this.find(1) !== -1
    if (sameRoute(route, this.snapshot.route) && canBack === this.snapshot.canBack && canForward === this.snapshot.canForward) return
    this.snapshot = { route, canBack, canForward }
    for (const listener of [...this.listeners]) listener()
  }
  private present(page: ShellPage): void {
    // Presentation projection is intentionally not an ':open' intent event:
    // Assistant's handler selects a session and may stage references.
    this.target?.dispatchEvent(new CustomEvent(SHELL_ROUTE_CHANGED, { detail: { page } }))
  }
}
