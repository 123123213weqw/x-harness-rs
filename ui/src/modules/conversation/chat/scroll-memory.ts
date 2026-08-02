import type { ChatScrollPosition, ChatViewInjected } from '../contract/slots'

/** Session-local reader memory and explicit local submit intent. No wire event
 * can request following; a hidden view only clears its stale reader bookmark. */
export class ChatScrollMemory {
  private readonly positions = new Map<string, ChatScrollPosition>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private disposed = false

  forSession(sessionId: string): ChatViewInjected['chatScroll'] {
    return {
      read: () => this.positions.get(sessionId) ?? null,
      save: position => {
        if (this.disposed) return
        if (position === null) this.positions.delete(sessionId)
        else this.positions.set(sessionId, position)
      },
      subscribeFollow: listener => {
        if (this.disposed) return () => {}
        const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
        listeners.add(listener)
        this.listeners.set(sessionId, listeners)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0 && this.listeners.get(sessionId) === listeners) this.listeners.delete(sessionId)
        }
      },
    }
  }

  /** Called synchronously at local prompt dispatch, never on a delayed receipt. */
  requestFollow(sessionId: string): void {
    if (this.disposed) return
    this.positions.delete(sessionId)
    const listeners = this.listeners.get(sessionId)
    for (const listener of [...listeners ?? []]) {
      if (!listeners?.has(listener)) continue
      // Presentation failure must not change whether a user's prompt is sent.
      try { listener() } catch (error) { console.error('[conversation] scroll intent listener failed:', error) }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const listeners of this.listeners.values()) listeners.clear()
    this.listeners.clear()
    this.positions.clear()
  }
}
