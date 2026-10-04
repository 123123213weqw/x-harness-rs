/** UI admission only. Session remains the owner of pagination, errors and data.
 * One upward reader intent can admit one page; arrivals/reflow never arm it. */
export class HistoryPageIntent {
  private armed = false
  private pending = false

  arm(): void { if (!this.pending) this.armed = true }
  cancel(): void { this.armed = false }

  shouldLoad(state: {
    ready: boolean; hasMore: boolean; loading: boolean; following: boolean
    head: number | null; top: number; viewport: number
  }): boolean {
    if (!state.ready || !state.hasMore || state.loading || state.following || this.pending) {
      this.cancel()
      return false
    }
    return this.armed && state.head !== null && Number.isFinite(state.top)
      && Number.isFinite(state.viewport) && state.viewport > 0
      && state.top <= Math.min(240, state.viewport / 2)
  }

  /** Shared by automatic and explicit requests: lock before the RPC/React tick. */
  begin(): boolean {
    if (this.pending) return false
    this.pending = true
    this.cancel()
    return true
  }

  /** No automatic draining after success, error, no-op or a delayed receipt. */
  end(): void { this.pending = false; this.cancel() }
}
