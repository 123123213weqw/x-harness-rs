import { isSessionEvent, validateCompactionEvent } from '../contract/wire-event-codec'
import type { Context, ConversationMatch, ConversationNodeDefinition, ConversationNodeContext } from '../types/runtime'
import { chatNode } from './common'
import { compactSource, compactSummary, updateCompactionState } from './command'
import { compactLifecycle, compactProgress, projectedCompactionView, type CompactionEvidence, type CompactionNode } from './compaction-lifecycle'

declare module '../contract/chat-nodes' {
  interface ChatNodeDataMap { compaction: CompactionNode }
}
function fallbackState(context: ConversationNodeContext<CompactionEvidence>): CompactionEvidence {
  return context.matches.reduce<CompactionEvidence>(updateCompactionState, {})
}

/** Automatic compaction progress, recovery and landed checkpoint contribution. */
export const compactionDefinition: ConversationNodeDefinition<CompactionEvidence> = {
  historyReuse: 'local', kind: 'compaction', target: 'chat',
  match: (event, view) => {
    if (view?.for === 'compaction') {
      const presentation = projectedCompactionView(view)
      if (typeof presentation?.sourceCommandId === 'string') return null
      if (presentation !== undefined) return { id: presentation.id, role: isSessionEvent(event, 'compaction/progress') ? 'update' : presentation.phase === 'running' ? 'start' : 'update' }
    }
    validateCompactionEvent(event)
    const checkpoint = compactSource(event)
    if (checkpoint !== undefined && checkpoint.sourceCommandId === undefined) return { id: checkpoint.compactionId, role: 'update' }
    if (isSessionEvent(event, 'compaction/start') || isSessionEvent(event, 'compaction/progress') || isSessionEvent(event, 'compaction/summary') || isSessionEvent(event, 'compaction/end')) {
      if (event.data.sourceCommandId !== undefined) return null
      const compactionId = event.data.compactionId
      if (typeof compactionId !== 'string' || compactionId === '') return null
      return { id: compactionId, role: isSessionEvent(event, 'compaction/start') ? 'start' : 'update' }
    }
    return null
  },
  start: (_context, match) => match === undefined ? {} : updateCompactionState({}, match),
  update: (context, match) => updateCompactionState(context.state, match),
  buildViewNode: context => {
    const state = context.state ?? fallbackState(context)
    if (state.checkpoint && !state.presentation) {
      const data = { ...compactSummary(state.summary, state.checkpoint), progress: compactProgress(isSessionEvent(state.progress?.event, 'compaction/progress') ? state.progress.event.data.progress : undefined) }
      return chatNode(context, 'compaction', data.seq, data)
    }
    const data = compactLifecycle(state)
    return data ? chatNode(context, 'compaction', data.seq, data) : null
  },
}
export function registerCompactionConversationNode(ctx: Context): void { ctx.conversationEvents.register(compactionDefinition) }
