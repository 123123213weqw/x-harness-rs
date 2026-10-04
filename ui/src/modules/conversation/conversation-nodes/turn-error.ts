import { isSessionEvent } from '../contract/wire-event-codec'
import type { Context } from "../types/runtime"
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnErrorNode,
} from "../types/runtime"
import { displayFailureMessage } from '../runtime-values'
import { chatNode } from './common'

declare module "../contract/chat-nodes" {
  interface ChatNodeDataMap {
    /** Terminal turn failure not superseded by retry. */
    'turn-error': TurnErrorNode
  }
}

interface TurnErrorState {
  readonly turn: number
  readonly hidden: boolean
  readonly failure?: ({
    readonly seq: number
    readonly time: number
    readonly message: string
    readonly code?: string
  }) | undefined
}

function lastStep(context: ConversationNodeContext<TurnErrorState>): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return 0
  return location.turn.steps.at(-1)?.step ?? 0
}

function retryTurn(event: Parameters<ConversationNodeDefinition['match']>[0]): number | undefined {
  return isSessionEvent(event, 'llm/retry') || isSessionEvent(event, 'llm/retry-started')
    ? event.data.turn
    : undefined
}

function failureFrom(match: ConversationMatch): TurnErrorState['failure'] | undefined {
  if (!isSessionEvent(match.event, 'turn/end') || match.event.data.reason.kind !== 'error') return undefined
  const reason = match.event.data.reason
  const failure = reason.error ?? ('failure' in reason ? reason.failure : undefined)
  if (failure === undefined || failure === null) return undefined
  return {
    seq: match.event.seq,
    time: match.event.time,
    message: displayFailureMessage(failure),
    code: failure.code,
  }
}

function fallbackState(context: ConversationNodeContext<TurnErrorState>): TurnErrorState | undefined {
  const end = context.matches.find(match => failureFrom(match) !== undefined)
  if (!isSessionEvent(end?.event, 'turn/end')) return undefined
  const failure = failureFrom(end)
  if (failure === undefined) return undefined
  const turn = end.event.data.turn
  return {
    turn,
    hidden: context.matches.some(match => retryTurn(match.event) === turn),
    failure,
  }
}

/** Terminal turn failure Definition, suppressed when the turn owns a retry chain. */
export const turnErrorDefinition: ConversationNodeDefinition<TurnErrorState> = {
  kind: 'turn-error',
  target: 'chat',
  match: (event) => {
    if (isSessionEvent(event, 'turn/start')) return { id: String(event.data.turn), role: 'start' }
    if (isSessionEvent(event, 'turn/end') && event.data.reason.kind === 'error') {
      return { id: String(event.data.turn), role: 'update' }
    }
    const turn = retryTurn(event)
    return turn === undefined ? null : { id: String(turn), role: 'update' }
  },
  start: (_context, match) => {
    if (!isSessionEvent(match.event, 'turn/start')) throw new Error('turn-error start requires turn/start')
    return { turn: match.event.data.turn, hidden: false }
  },
  update: (context, match) => {
    const failure = failureFrom(match)
    if (failure !== undefined) return { ...context.state, failure }
    return retryTurn(match.event) === context.state.turn
      ? { ...context.state, hidden: true }
      : context.state
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state?.failure === undefined) return null
    const failure = state.failure
    const node: TurnErrorNode = {
      kind: 'turn-error',
      seq: failure.seq,
      time: failure.time,
      turn: state.turn,
      step: lastStep(context),
      message: failure.message,
      ...failure.code === undefined ? {} : { code: failure.code },
    }
    if (!state.hidden) return chatNode(context, 'turn-error', node.seq, node)
    const current = context.current.get('chat')
    return current === undefined || current === null
      ? null
      : chatNode(context, 'turn-error', node.seq, node, { visibility: 'hidden' })
  },
}

/**
 * Register the terminal Turn-error business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnErrorConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(turnErrorDefinition)
}
