import { isObjectRecord } from '../../shared/runtime-types'
import { isChatData } from '../contract/chat-node-codec'
import { isSessionEvent } from '../contract/wire-event-codec'
import type { Context } from "../types/runtime"
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnLocation,
} from "../types/runtime"
import { isAppendSurfaceEvent, toAssistantBlocks } from '../runtime-values'
import type {
  AssistantChatData, FinalAssistantChatData, TurnTailChatData,
} from '../contract/chat-nodes'
import { deriveTurnMetrics } from '../chat/turn-metrics'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common'

declare module "../contract/chat-nodes" {
  interface ChatNodeDataMap {
    /** Completed-turn actions and extension tail. */
    'turn-tail': TurnTailChatData
  }
}

declare module "../types/runtime" {
  interface ConversationTurnDataMap {
    /** Closing Assistant and footer facts derived for this completed Turn. */
    'turn-tail': TurnTailChatData
  }
}

interface TurnTailState {
  readonly turn: number
  readonly end?: (ConversationMatch) | undefined
}

interface StepEvidence {
  readonly streamedText: boolean
  readonly finalized: boolean
}

function hasTextAssistant(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  return isSessionEvent(event, 'assistant/message')
    && isAppendSurfaceEvent(event)
    && toAssistantBlocks(event.data.message.content)
      .some(block => block.kind === 'text' && block.text.trim() !== '')
}

function chunkHasText(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (!isSessionEvent(event, 'assistant/chunk')) return false
  const chunk = event.data.chunk
  if (chunk.type === 'text-delta') return chunk.text.trim() !== ''
  return chunk.type === 'block-end'
    && isObjectRecord(chunk.block) && chunk.block.type === 'text'
    && typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
}

function turnCoordinates(event: Parameters<ConversationNodeDefinition['match']>[0]): {
  readonly turn: number
  readonly step?: (number) | undefined
} | undefined {
  if (isSessionEvent(event, 'assistant/message')
    || isSessionEvent(event, 'assistant/chunk')
    || isSessionEvent(event, 'step/end')) {
    return { turn: event.data.turn, step: event.data.step }
  }
  if (isSessionEvent(event, 'llm/retry')) return { turn: event.data.turn, step: event.data.step }
  return undefined
}

function closingAnchor(context: ConversationNodeContext<TurnTailState>): number {
  let anchor = context.matches.find(match => isSessionEvent(match.event, 'turn/end'))?.event.seq
    ?? context.start?.event.seq
    ?? context.matches[0]?.event.seq
    ?? 0
  const steps = new Map<number, StepEvidence>()
  for (const match of context.matches) {
    const event = match.event
    if (isSessionEvent(event, 'turn/end')) continue
    const coordinates = turnCoordinates(event)
    if (coordinates?.step === undefined) continue
    const previous = steps.get(coordinates.step) ?? { streamedText: false, finalized: false }
    if (isSessionEvent(event, 'assistant/chunk')) {
      steps.set(coordinates.step, {
        ...previous,
        streamedText: previous.streamedText || chunkHasText(event),
      })
      continue
    }
    if (isSessionEvent(event, 'assistant/message')) {
      steps.set(coordinates.step, { streamedText: false, finalized: true })
      if (hasTextAssistant(event)) {
        anchor = event.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup
      }
      continue
    }
    if (isSessionEvent(event, 'llm/retry')) {
      steps.set(coordinates.step, { streamedText: false, finalized: false })
      continue
    }
    if (isSessionEvent(event, 'step/end') && previous.streamedText && !previous.finalized) {
      anchor = event.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedFollowup
    }
  }
  return anchor
}

function turnLocation(context: ConversationNodeContext<TurnTailState>): TurnLocation | undefined {
  const location = context.start?.location ?? context.matches[0]?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
}

function hasText(data: AssistantChatData): data is FinalAssistantChatData {
  return data.finalNode !== undefined
    && data.blocks.some(block => block.kind === 'text' && block.text.trim() !== '')
}

function tailData(context: ConversationNodeContext<TurnTailState>): TurnTailChatData | null {
  const end = context.state?.end
    ?? context.matches.find(match => isSessionEvent(match.event, 'turn/end'))
  if (!isSessionEvent(end?.event, 'turn/end')) return null
  const turn = turnLocation(context)
  if (turn === undefined) return null
  const assistants = turn.steps
    .map(step => step.data.get('assistant-step'))
    .filter((candidate): candidate is Readonly<AssistantChatData> => isChatData('assistant-step', candidate))
  const finalized = assistants
    .filter((candidate): candidate is Readonly<FinalAssistantChatData> => candidate.finalNode !== undefined)
    .sort((left, right) => left.finalNode.seq - right.finalNode.seq)
  const closing = finalized.findLast(hasText) ?? null
  let latestTranscriptSeq = finalized.at(-1)?.finalNode.seq
  for (const match of context.matches) {
    const event = match.event
    const candidate = isSessionEvent(event, 'tool/call')
      || (isSessionEvent(event, 'tool/result') && isAppendSurfaceEvent(event))
      || (isSessionEvent(event, 'turn/end') && event.data.reason.kind === 'error')
      || isSessionEvent(event, 'llm/retry')
      ? event.seq
      : undefined
    if (candidate !== undefined && (latestTranscriptSeq === undefined || candidate > latestTranscriptSeq)) {
      latestTranscriptSeq = candidate
    }
  }
  const metrics = deriveTurnMetrics(finalized.map(candidate => candidate.finalNode)).get(end.event.data.turn)
  return {
    turn: end.event.data.turn,
    seq: end.event.seq,
    time: end.event.time,
    closing,
    branchUnavailable: closing === null || latestTranscriptSeq !== closing.finalNode.seq,
    ...metrics?.ttftMs === undefined ? {} : { ttftMs: metrics.ttftMs },
    ...metrics?.tokensPerSecond === undefined ? {} : { tokensPerSecond: metrics.tokensPerSecond },
  }
}

/** Completed-turn footer Definition independent of any Assistant row. */
export const turnTailDefinition: ConversationNodeDefinition<TurnTailState> = {
  kind: 'turn-tail',
  target: 'chat',
  match: (event) => {
    if (isSessionEvent(event, 'turn/start')) return { id: String(event.data.turn), role: 'start' }
    if (isSessionEvent(event, 'turn/end')) return { id: String(event.data.turn), role: 'update' }
    if (isSessionEvent(event, 'tool/call') || isSessionEvent(event, 'tool/result')) {
      return { id: String(event.data.turn), role: 'update' }
    }
    const coordinates = turnCoordinates(event)
    if (coordinates !== undefined) return { id: String(coordinates.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (!isSessionEvent(match.event, 'turn/start')) throw new Error('turn-tail start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update: (context, match) => isSessionEvent(match.event, 'turn/end')
    ? { ...context.state, end: match }
    : context.state,
  publication: match => isSessionEvent(match.event, 'turn/end') ? 'immediate' : 'none',
  buildLocationData: (context, scope) => {
    if (scope !== 'turn') return null
    const value = tailData(context)
    return value === null ? null : {
      kind: 'turn',
      turn: value.turn,
      key: 'turn-tail',
      value,
    }
  },
  buildViewNode: (context) => {
    const turn = turnLocation(context)
    const data = turn?.data.get('turn-tail')
    return isChatData('turn-tail', data) ? chatNode(context, 'turn-tail', closingAnchor(context), data) : null
  },
}

/**
 * Register completed-Turn footer data and its Chat node contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnTailConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(turnTailDefinition)
}
