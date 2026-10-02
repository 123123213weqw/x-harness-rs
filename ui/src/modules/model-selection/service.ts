import { requireCoreContext, isSessions, isConnection, isConversation } from './core-context'
import { Service } from '@xharness/cordis'
import { ModelDirectory } from './directory'
import type { ModelClientContext } from './contracts'

// Cordis is dynamically injected; narrow its constructor to the context this
// service actually consumes, rather than leaking its open service registry.
const ContextService = Service
export class ModelDirectoryResolver extends ContextService {
  static inject = ['connection', 'sessions', 'remote']
  readonly live = { directories: new Map<string, ModelDirectory>() }
  readonly blockReason: () => string
  constructor(ctx: ModelClientContext, config: { blockReason(): string }) {
    super(requireCoreContext(ctx), 'modelDirectories')
    this.blockReason = config.blockReason
    ctx.on('connection/reset', () => { for (const directory of this.live.directories.values()) directory.resetConnected() })
    const refresh = () => { for (const directory of this.live.directories.values()) void directory.load().catch(() => {}) }
    ctx.remote.$on('llm/adapters-updated', refresh)
    ctx.remote.$on('settings/document-updated', refresh)
  }
  directoryFor(sessionId: string): ModelDirectory {
    const existing = this.live.directories.get(sessionId)
    if (existing !== undefined) return existing
    const sessions: unknown = this.ctx.get('sessions')
    if (!isSessions(sessions)) throw new Error('model-selection sessions service is unavailable')
    const scope = sessions.scope(sessionId)
    if (scope === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`)
    const connection: unknown = this.ctx.get('connection')
    if (!isConnection(connection)) throw new Error('model-selection connection service is unavailable')
    const directory = new ModelDirectory(connection.api.sessions, sessionId, () => sessions.subagentAddress(sessionId) === undefined)
    this.live.directories.set(sessionId, directory)
    const conversation: unknown = this.ctx.get('conversation')
    if (isConversation(conversation)) {
      const publish = () => conversation.blocks.set(sessionId, directory.store.getSnapshot().routable === false ? { reason: this.blockReason() } : undefined)
      publish()
      scope.effect(() => {
        const stop = directory.store.subscribe(publish)
        return () => { stop(); conversation.blocks.set(sessionId, undefined) }
      }, 'ui-model-selection: composer block')
    }
    scope.effect(() => () => { directory.dispose(); this.live.directories.delete(sessionId) }, 'ui-model-selection: session directory')
    return directory
  }
}
