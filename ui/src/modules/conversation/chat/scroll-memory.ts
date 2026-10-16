import type { ChatScrollPosition, ChatViewInjected } from '../contract/slots'

/** Session-local reader memory and explicit local submit intent. No wire event
 * can request following; a hidden view only clears its stale reader bookmark. */
export class ChatScrollMemory {
  private readonly positions = new Map<string, ChatScrollPosition>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private disposed = false

  constructor(private readonly onPosition?: (sessionId: string, position: ChatScrollPosition | null) => void) {}

  private publish(sessionId: string, position: ChatScrollPosition | null): void {
    if (this.disposed) return
    try { this.onPosition?.(sessionId, position) }
    catch (error) { console.error('[conversation] reading target listener failed:', error) }
  }

  forSession(sessionId: string): ChatViewInjected['chatScroll'] {
    // Slot injection may run in a discarded concurrent render. Only committed
    // position saves and explicit follow intents may publish a runtime hint.
    return {
      read: () => this.positions.get(sessionId) ?? null,
      save: position => {
        if (this.disposed) return
        if (position === null) this.positions.delete(sessionId)
        else this.positions.set(sessionId, position)
        this.publish(sessionId, position)
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
    this.publish(sessionId, null)
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
