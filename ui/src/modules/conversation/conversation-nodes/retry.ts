import { isSessionEvent } from '../contract/wire-event-codec'
import type { Context } from "../types/runtime"
import type {
  ConversationLocation, ConversationNodeDefinition, ModelRetryNode,
} from "../types/runtime"
import type { RetryChatData } from '../contract/chat-nodes'
import { chatNode } from './common'

declare module "../contract/chat-nodes" {
  interface ChatNodeDataMap {
    /** Producer-correlated model retry chain. */
    'model-retry': RetryChatData
  }
}

/** Accumulated retry attempts sharing one producer-owned RetryId. */
export interface RetryState {
  readonly turn: number
  readonly step: number
  readonly attempts: readonly ModelRetryNode[]
}

function scheduledNode(match: Parameters<ConversationNodeDefinition['start']>[1]): ModelRetryNode | undefined {
  if (!isSessionEvent(match.event, 'llm/retry')) return undefined
  return {
    kind: 'model-retry',
    seq: match.event.seq,
    time: match.event.time,
    retryState: 'scheduled',
    ...match.event.data,
  }
}

/** A scheduled attempt is cancelled once either owning boundary closes. */
function isClosed(location: ConversationLocation): boolean {
  return (location.kind === 'step' && location.step.status === 'closed')
    || ((location.kind === 'step' || location.kind === 'turn') && location.turn.status === 'closed')
}

/** Replay and history cuts preserve observed attempts without inventing facts. */
export function updateRetryState(state: RetryState | undefined, match: Parameters<ConversationNodeDefinition['start']>[1]): RetryState | undefined {
  const event = match.event
  if (!isSessionEvent(event, 'llm/retry') && !isSessionEvent(event, 'llm/retry-started')) return state
  const attempts = state?.attempts ?? []
  const index = attempts.findIndex(attempt => attempt.retry === event.data.retry)
  if (isSessionEvent(event, 'llm/retry')) {
    const node = scheduledNode(match)
    if (node === undefined) return state
    const next = index < 0 ? [...attempts, node] : attempts.map((old, at) => at === index ? { ...node, retryState: old.retryState } : old)
    return { turn: event.data.turn, step: event.data.step, attempts: next }
  }
  const old = attempts[index]
  const started: ModelRetryNode = old === undefined ? {
    kind: 'model-retry', seq: event.seq, time: event.time, ...event.data, retryState: 'started', partial: true,
  } : { ...old, retryState: 'started' }
  return { turn: event.data.turn, step: event.data.step, attempts: index < 0 ? [...attempts, started] : attempts.map((old, at) => at === index ? started : old) }
}
/** Producer-correlated model retry chain Definition. */
export const retryDefinition: ConversationNodeDefinition<RetryState | undefined> = {
  historyReuse: 'local', kind: 'model-retry', target: 'chat',
  match: event => {
    if (!isSessionEvent(event, 'llm/retry') && !isSessionEvent(event, 'llm/retry-started')) return null
    const id = event.data.retryId
    return typeof id === 'string' && id !== '' ? { id, role: isSessionEvent(event, 'llm/retry') && event.data.retry === 1 ? 'start' : 'update' } : null
  },
  start: (_context, match) => updateRetryState(undefined, match),
  update: (context, match) => updateRetryState(context.state, match),
  buildViewNode: (context) => {
    const state = context.state ?? context.matches.reduce<RetryState | undefined>(updateRetryState, undefined)
    if (state === undefined || state.attempts.length === 0) return null
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' as const }
    const stateAttempts = state.attempts
    const attempts = stateAttempts.map((attempt, index) =>
      index === stateAttempts.length - 1
        && attempt.retryState === 'scheduled'
        && isClosed(location)
        ? { ...attempt, retryState: 'cancelled' as const }
        : attempt)
    const current = attempts.at(-1)
    if (current === undefined) return null
    const data: RetryChatData = { attempts, current }
    return chatNode(context, 'model-retry', attempts[0]?.seq ?? current.seq, data)
  },
}

/**
 * Register the correlated model-retry business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerRetryConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(retryDefinition)
}
