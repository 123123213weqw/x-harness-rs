import {isTrajectoryEvent} from './wire-event-codec'
import type { Context } from './contracts'
import type {
  ConversationMatch, ConversationNodeDefinition, RequestView,
} from '../client-runtime/index'
import { trajectoryNode } from './trajectory-definition-common'

interface CompactionState {
  readonly start: ConversationMatch
  readonly summary?: ConversationMatch
  readonly end?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

function checkpointId(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): string | undefined {
  if (!isTrajectoryEvent(event, 'user/message')) return undefined
  const source = event.data.source
  return source.kind === 'plugin' && source.plugin === 'compact'
    && typeof source.compactionId === 'string' && source.compactionId !== ''
    ? source.compactionId
    : undefined
}

function eventCompactionId(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): string | undefined {
  if (!isTrajectoryEvent(event, 'compaction/start')
    && !isTrajectoryEvent(event, 'compaction/summary')
    && !isTrajectoryEvent(event, 'compaction/end')) return undefined
  const value: unknown = event.data.compactionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requestFromState(
  state: CompactionState,
): Extract<RequestView, { purpose: 'compaction' }> | undefined {
  const start = state.start.event
  if (!isTrajectoryEvent(start, 'compaction/start')) return undefined
  const summary = state.summary?.event
  const end = state.end?.event
  const checkpoint = state.checkpoint?.event
  return {
    purpose: 'compaction',
    startSeq: start.seq,
    turn: start.data.turn,
    step: 0,
    startedAt: start.time,
    completedAt: isTrajectoryEvent(end, 'compaction/end') ? end.time : null,
    status: !isTrajectoryEvent(end, 'compaction/end')
      ? 'running'
      : end.data.error === undefined ? 'complete' : 'error',
    ...(isTrajectoryEvent(end, 'compaction/end') && end.data.error !== undefined
      ? { error: end.data.error }
      : {}),
    ...(!isTrajectoryEvent(summary, 'compaction/summary')
      ? {}
      : {
        resultSeq: summary.seq,
        summary: summary.data.summary,
        ...(summary.data.rawOutput === undefined ? {} : { rawOutput: summary.data.rawOutput }),
        provenance: { provider: summary.data.provider, model: summary.data.model },
        requestConfig: {
          provider: summary.data.provider,
          model: summary.data.model,
          purpose: 'compaction',
          ...(summary.data.maxTokens === undefined ? {} : { maxTokens: summary.data.maxTokens }),
        },
        ...(summary.data.usage === undefined ? {} : { usage: summary.data.usage }),
      }),
    ...(isTrajectoryEvent(checkpoint, 'user/message') ? { replacementSeq: checkpoint.seq } : {}),
  }
}

const trajectoryCompactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'trajectory-compaction',
  target: 'trajectory',
  match: (event) => {
    const compactId = eventCompactionId(event)
    if (compactId !== undefined) {
      return { id: compactId, role: isTrajectoryEvent(event, 'compaction/start') ? 'start' : 'update' }
    }
    const checkpoint = checkpointId(event)
    return checkpoint === undefined ? null : { id: checkpoint, role: 'update' }
  },
  start: (_context, match) => {
    if (!isTrajectoryEvent(match.event, 'compaction/start')) {
      throw new Error('trajectory-compaction start requires compaction/start')
    }
    return { start: match }
  },
  update: (context, match) => {
    if (isTrajectoryEvent(match.event, 'compaction/summary')) return { ...context.state, summary: match }
    if (isTrajectoryEvent(match.event, 'compaction/end')) return { ...context.state, end: match }
    return checkpointId(match.event) === undefined
      ? context.state
      : { ...context.state, checkpoint: match }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const request = requestFromState(context.state)
    return request === undefined
      ? null
      : trajectoryNode(context, request.startSeq, { kind: 'compaction', request })
  },
}

interface SessionEndState {
  readonly seq: number
  readonly time: number
}

const trajectorySessionEndDefinition: ConversationNodeDefinition<SessionEndState> = {
  kind: 'trajectory-session-end',
  target: 'trajectory',
  match: event => event.type === 'session/end-seed'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => ({ seq: match.event.seq, time: match.event.time }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'session-end',
      seq: context.state.seq,
      time: context.state.time,
    }),
}

/**
 * Register Trajectory compaction requests and session boundaries.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryCompactionDefinitions(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryCompactionDefinition)
  ctx.conversationEvents.register(trajectorySessionEndDefinition)
}
