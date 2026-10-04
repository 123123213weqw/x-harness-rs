import type {ClientConnectionRpc} from '../client-connection/index'
import {automationView, domainError, type AutomationView} from './automation-card-model'

/** Transport and invalidation only: all state transitions remain on the Host. */
export class AutomationCardClient {
  private listeners = new Map<string, Set<() => void>>()
  constructor(private readonly rpc: ClientConnectionRpc) {}
  subscribe(sessionId: string, listener: () => void) {
    let group = this.listeners.get(sessionId)
    if (!group) this.listeners.set(sessionId, group = new Set())
    const subscribers = group
    subscribers.add(listener)
    return () => { subscribers.delete(listener); if (!subscribers.size) this.listeners.delete(sessionId) }
  }
  async execute(sessionId: string, id: string, action: 'view'|'pause'|'resume'|'delete', signal?: AbortSignal): Promise<AutomationView | undefined> {
    const controller = signal === undefined ? new AbortController() : undefined
    const timeout = controller === undefined ? undefined : setTimeout(() => controller.abort(), 15_000)
    try {
      const result = await this.rpc.call('/api', 'automation/manage', {sessionId, command: {action, id}}, signal ?? controller?.signal)
      if (!result.ok) throw Error(result.error.message)
      const error = domainError(result.value)
      if (error) throw Error(error)
      if (action !== 'view') for (const listener of this.listeners.get(sessionId) ?? []) listener()
      return automationView(result.value)
    } finally { clearTimeout(timeout) }
  }
}
