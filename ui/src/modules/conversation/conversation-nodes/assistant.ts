import { isSessionEvent } from '../contract/wire-event-codec'
import { preparingCall } from '../chat/preparing-call'
import type { Context } from "../types/runtime"
import type {
  AssistantBlock, AssistantMessageNode, ConversationLocation, ConversationMatch,
  ConversationNodeContext, ConversationNodeDefinition,
} from "../types/runtime"
import {
  emptyAssistantBlock, isAppendSurfaceEvent, isTokenDelta, toAssistantBlock, toAssistantBlocks,
} from '../runtime-values'
import type { AssistantChatData } from '../contract/chat-nodes'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common'

declare module "../contract/chat-nodes" {
  interface ChatNodeDataMap {
    /** Streaming, settled, or interrupted Assistant step. */
    'assistant-step': AssistantChatData
  }
}

declare module "../types/runtime" {
  interface ConversationStepDataMap {
    /** Streaming, settled, or interrupted Assistant material for this Step. */
    'assistant-step': AssistantChatData
  }
}

interface AssistantState {
  readonly turn: number
  readonly step: number
  readonly blocks: readonly (AssistantBlock | undefined)[]
  readonly firstVisibleSeq: number | undefined
  readonly firstVisibleTime: number | undefined
  readonly firstTokenTime: number | undefined
  readonly hidden: boolean
  readonly final: ConversationMatch | undefined
  readonly usage: unknown
}

function initialState(turn: number, step: number): AssistantState {
  return {
    turn,
    step,
    blocks: [],
    firstVisibleSeq: undefined,
    firstVisibleTime: undefined,
    firstTokenTime: undefined,
    hidden: false,
    final: undefined,
    usage: undefined,
  }
}

function compactBlocks(blocks: readonly (AssistantBlock | undefined)[]): AssistantBlock[] {
  return blocks.filter((block): block is AssistantBlock => block !== undefined)
}

function hasVisibleContent(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'tool-call') return false
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
  })
}

function hasInterruptionEvidence(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
  })
}

function resetForRetry(state: AssistantState): AssistantState {
  return {
    ...initialState(state.turn, state.step),
    firstTokenTime: state.firstTokenTime,
    hidden: true,
  }
}

function updateChunk(state: AssistantState, match: ConversationMatch): AssistantState {
  if (!isSessionEvent(match.event, 'assistant/chunk')) return state
  const chunk = match.event.data.chunk
  const blocks = [...state.blocks]
  switch (chunk.type) {
    case 'block-start':
      blocks[chunk.index] = emptyAssistantBlock(chunk.blockType)
      break
    case 'text-delta': {
      const previous = blocks[chunk.index]
      blocks[chunk.index] = { kind: 'text', text: (previous?.kind === 'text' ? previous.text : '') + chunk.text }
      break
    }
    case 'reasoning-delta': {
      const previous = blocks[chunk.index]
      blocks[chunk.index] = { kind: 'reasoning', text: (previous?.kind === 'reasoning' ? previous.text : '') + chunk.text }
      break
    }
    case 'tool-call-delta': {
      const previous = blocks[chunk.index]
      const base = previous?.kind === 'tool-call'
        ? previous
        : { kind: 'tool-call' as const, callId: '', name: '', argsRaw: '' }
      blocks[chunk.index] = {
        kind: 'tool-call',
        callId: base.callId || String(chunk.id),
        // Argument-only continuation chunks may carry an empty name.
        // Preserve the tool identity already received for this block.
        name: chunk.name || base.name,
        argsRaw: base.argsRaw + chunk.argumentsDelta,
      }
      break
    }
    case 'block-end':
      blocks[chunk.index] = toAssistantBlock(chunk.block)
      break
    case 'usage':
      return { ...state, usage: chunk.usage }
    default:
      return state
  }
  const visible = hasVisibleContent(compactBlocks(blocks))
  const firstToken = isTokenDelta(chunk)
  return {
    ...state,
    blocks,
    hidden: visible ? false : state.hidden,
    ...visible && state.firstVisibleSeq === undefined
      ? { firstVisibleSeq: match.event.seq, firstVisibleTime: match.event.time }
      : {},
    ...firstToken && state.firstTokenTime === undefined
      ? { firstTokenTime: match.event.time }
      : {},
  }
}

function closedBoundary(location: ConversationLocation): { seq: number; time: number } | undefined {
  if (location.kind === 'step' && location.step.status === 'closed' && location.step.end !== undefined) {
    return location.step.end
  }
  if ((location.kind === 'step' || location.kind === 'turn')
    && location.turn.status === 'closed' && location.turn.end !== undefined) {
    return location.turn.end
  }
  return undefined
}

function finalNode(
  state: AssistantState,
  context: ConversationNodeContext<AssistantState>,
): AssistantMessageNode | undefined {
  const final = state.final
  if (isSessionEvent(final?.event, 'assistant/message')) {
    const event = final.event
    return {
      kind: 'assistant',
      seq: event.seq,
      messageId: event.data.message.id,
      time: event.time,
      turn: state.turn,
      step: state.step,
      blocks: toAssistantBlocks(event.data.message.content),
      usage: event.data.usage,
      timing: {
        stepStartTime: context.start?.event.time ?? null,
        firstTokenTime: state.firstTokenTime ?? null,
        completedTime: event.time,
      },
      ...event.data.interrupted === true ? { interrupted: true } : {},
    }
  }
  const location = context.start?.location ?? context.matches.at(-1)?.location
  const boundary = location === undefined ? undefined : closedBoundary(location)
  const blocks = compactBlocks(state.blocks)
  if (boundary === undefined || !hasInterruptionEvidence(blocks)) return undefined
  return {
    kind: 'assistant',
    seq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
    time: boundary.time,
    turn: state.turn,
    step: state.step,
    blocks,
    interrupted: true,
  }
}

function fallbackState(context: ConversationNodeContext<AssistantState>): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    if (isSessionEvent(match.event, 'assistant/chunk')) {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = updateChunk(state, match)
      continue
    }
    if (isSessionEvent(match.event, 'assistant/message')) {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = {
        ...state,
        blocks: toAssistantBlocks(match.event.data.message.content),
        hidden: false,
        final: match,
        usage: match.event.data.usage,
      }
      continue
    }
    if (isSessionEvent(match.event, 'llm/retry') && state !== undefined) {
      state = resetForRetry(state)
    }
  }
  return state
}

interface AssistantProjection {
  readonly data: AssistantChatData
  readonly anchorSeq: number
  readonly visible: boolean
  readonly settled: AssistantMessageNode | undefined
}

function projectAssistant(context: ConversationNodeContext<AssistantState>): AssistantProjection | undefined {
  const state = context.state ?? fallbackState(context)
  if (state === undefined) return undefined
  const settled = finalNode(state, context)
  const blocks = settled?.blocks ?? compactBlocks(state.blocks)
  const visible = hasVisibleContent(blocks) || settled === undefined && blocks.some(preparingCall)
  const status = settled?.interrupted === true
    ? 'interrupted'
    : settled === undefined ? 'running' : 'settled'
  const anchorSeq = settled?.seq ?? state.firstVisibleSeq ?? context.matches[0]?.event.seq ?? 0
  const time = settled?.time ?? state.firstVisibleTime ?? context.matches[0]?.event.time ?? 0
  return {
    anchorSeq,
    visible,
    settled,
    data: {
      status,
      turn: state.turn,
      step: state.step,
      blocks,
      time,
      ...state.usage === undefined ? {} : { usage: state.usage },
      ...settled === undefined ? {} : { finalNode: settled },
    },
  }
}

/** Per-step Assistant streaming/final/interruption Definition. */
export const assistantDefinition: ConversationNodeDefinition<AssistantState> = {
  historyReuse: 'local',
  kind: 'assistant-step',
  target: 'chat',
  match: (event) => {
    if (isSessionEvent(event, 'step/start')) return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (isSessionEvent(event, 'assistant/chunk')
      || (isSessionEvent(event, 'assistant/message') && isAppendSurfaceEvent(event))) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    if (isSessionEvent(event, 'llm/retry')) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (!isSessionEvent(match.event, 'step/start')) throw new Error('assistant-step start requires step/start')
    return initialState(match.event.data.turn, match.event.data.step)
  },
  update: (context, match) => {
    if (isSessionEvent(match.event, 'assistant/chunk')) return updateChunk(context.state, match)
    if (isSessionEvent(match.event, 'assistant/message')) {
      return {
        ...context.state,
        blocks: toAssistantBlocks(match.event.data.message.content),
        hidden: false,
        final: match,
        usage: match.event.data.usage,
      }
    }
    if (isSessionEvent(match.event, 'llm/retry')) {
      return resetForRetry(context.state)
    }
    return context.state
  },
  publication: (match) => {
    if (isSessionEvent(match.event, 'step/start')) return 'none'
    if (!isSessionEvent(match.event, 'assistant/chunk')) return 'immediate'
    const type = match.event.data.chunk.type
    return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame'
  },
  buildLocationData: (context, scope) => {
    if (scope !== 'step') return null
    const projected = projectAssistant(context)
    if (projected === undefined) return null
    return {
      kind: 'step',
      turn: projected.data.turn,
      step: projected.data.step,
      key: 'assistant-step',
      value: projected.data,
    }
  },
  buildViewNode: (context) => {
    const projected = projectAssistant(context)
    if (projected === undefined) return null
    if (projected.settled === undefined && !projected.visible) {
      const state = context.state ?? fallbackState(context)
      if (state === undefined) return null
      const current = context.current.get('chat')
      // A preparing tool call can materialize a row without text/reasoning.
      // Once arguments complete or retry clears content, hide that same key
      // rather than withdrawing an already materialized target.
      if (current === undefined || current === null) return null
    }
    return chatNode(context, 'assistant-step', projected.anchorSeq, projected.data, {
      visibility: projected.settled?.interrupted === true || projected.visible ? 'visible' : 'hidden',
    })
  },
}

/**
 * Register the Assistant lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerAssistantConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(assistantDefinition)
}
