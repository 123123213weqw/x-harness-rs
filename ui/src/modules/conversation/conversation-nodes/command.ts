import { isSessionEvent, validateCompactionEvent } from '../contract/wire-event-codec'
import { isUnknownArray } from '../wire-guards'
import { isObjectRecord } from '../../shared/runtime-types'
import { compactLifecycle, compactProgress, projectedCompactionView, type CompactionEvidence } from './compaction-lifecycle'
import type { Context } from "../types/runtime"
import type {
  CommandNode, CompactionSummaryNode, ConversationMatch, ConversationNodeContext,
  ConversationNodeDefinition,
} from "../types/runtime"
import { isReplacementSurfaceEvent } from '../runtime-values'
import type { CompactionCheckpointSource } from "../types/wire"
import type { ManualCompactionChatData } from '../contract/chat-nodes'
import { chatNode } from './common'

declare module "../contract/chat-nodes" {
  interface ChatNodeDataMap {
    /** Ordinary slash-command lifecycle. */
    command: CommandNode
    /** Manual compact command combined with its compaction transaction. */
    'manual-compaction': ManualCompactionChatData
  }
}

type CommandId = CommandNode['commandId']

const COMPACT_PLUGIN: CompactionCheckpointSource['plugin'] = 'compact'

interface CommandState extends CompactionEvidence {
  readonly command: CommandNode
  readonly summary?: (ConversationMatch) | undefined
  readonly checkpoint?: (ConversationMatch) | undefined
}


function commandFromRun(match: ConversationMatch): CommandNode {
  if (!isSessionEvent(match.event, 'command/run')) throw new Error('command start requires command/run')
  const data = match.event.data
  return {
    kind: 'command',
    seq: match.event.seq,
    time: match.event.time,
    commandId: data.commandId,
    name: data.name,
    args: data.args ?? null,
    outcome: null,
  }
}

function commandFromDone(match: ConversationMatch, previous?: CommandNode): CommandNode {
  if (!isSessionEvent(match.event, 'command/done')) throw new Error('command update requires command/done')
  const data = match.event.data
  const sourceEventSeq = data.kind === 'success'
    && data.sourceEventSeq !== undefined
    && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0
    ? data.sourceEventSeq
    : undefined
  return {
    kind: 'command',
    seq: previous?.seq ?? match.event.seq,
    time: previous?.time ?? match.event.time,
    commandId: data.commandId,
    name: previous?.name ?? null,
    args: previous?.args ?? null,
    outcome: {
      kind: data.kind,
      ...data.text === undefined ? {} : { text: data.text },
      ...sourceEventSeq === undefined ? {} : { sourceEventSeq },
    },
  }
}

/**
 * Read correlation identity from a compaction replacement checkpoint.
 * @param event - candidate Session event.
 * @returns correlated compaction and optional command identity.
 */
function compactSource(event: Parameters<ConversationNodeDefinition['match']>[0]): {
  compactionId: string
  sourceCommandId?: (CommandId) | undefined
} | undefined {
  if (!isSessionEvent(event, 'user/message') || !isReplacementSurfaceEvent(event)) return undefined
  const source = event.data.source
  if (source.kind !== 'plugin' || source.plugin !== COMPACT_PLUGIN || typeof source.compactionId !== 'string') return undefined
  return {
    compactionId: source.compactionId,
    ...typeof source.sourceCommandId !== 'string' ? {} : { sourceCommandId: source.sourceCommandId },
  }
}

/**
 * Build the visible summary marker from optional lifecycle evidence.
 * @param match - compaction/summary Match, when loaded.
 * @param checkpoint - replacement checkpoint Match.
 * @returns final compaction summary Node data.
 */
function compactSummary(match: ConversationMatch | undefined, checkpoint: ConversationMatch): CompactionSummaryNode {
  let summary: string | null = null
  let shadowedItemCount: number | null = null
  let shadowedTokenCount: number | null = null
  if (isSessionEvent(match?.event, 'compaction/summary')) {
    const data = match.event.data
    if (isUnknownArray(data.summary)) {
      const text = data.summary
        .map((block: unknown) => isObjectRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
        .join('')
      summary = text.trim() === '' ? null : text
    }
    shadowedItemCount = isUnknownArray(data.shadowedSeqs)
      && data.shadowedSeqs.every(seq => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
      ? data.shadowedSeqs.length
      : null
    shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount)
      && data.shadowedTokenCount >= 0
      ? data.shadowedTokenCount
      : null
  }
  return {
    kind: 'compaction',
    seq: checkpoint.event.seq,
    time: checkpoint.event.time,
    summary,
    summaryEventSeq: match?.event.seq ?? null,
    shadowedItemCount,
    shadowedTokenCount,
  }
}

function fallbackState(context: ConversationNodeContext<CommandState>): CommandState | undefined {
  const lifecycle = context.matches.find(match => typeof projectedCompactionView(match.view)?.sourceCommandId === 'string' || isSessionEvent(match.event, 'compaction/start') && typeof match.event.data.sourceCommandId === 'string')
  if (lifecycle) {
    const view = projectedCompactionView(lifecycle.view)
    const run = context.matches.find(match => isSessionEvent(match.event, 'command/run'))
    const done = context.matches.find(match => isSessionEvent(match.event, 'command/done'))
    const commandId = view?.sourceCommandId ?? (isSessionEvent(lifecycle.event, 'compaction/start') ? lifecycle.event.data.sourceCommandId : undefined)
    if (commandId !== undefined) {
      const command: CommandNode = done ? commandFromDone(done) : run ? commandFromRun(run) : {
        kind: 'command', seq: view?.anchorSeq ?? lifecycle.event.seq, time: view?.time ?? lifecycle.event.time,
        commandId, name: 'compact', args: null, outcome: null,
      }
      return context.matches.reduce<CommandState>(updateCompactionState, { command })
    }
  }
  const done = context.matches.find(match => isSessionEvent(match.event, 'command/done'))
  const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined)
  const summary = context.matches.find(match => isSessionEvent(match.event, 'compaction/summary'))
  if (checkpoint === undefined) return done === undefined ? undefined : { command: commandFromDone(done) }
  const source = compactSource(checkpoint.event)
  if (source?.sourceCommandId === undefined) return done === undefined ? undefined : { command: commandFromDone(done) }
  const fallbackCommand = done === undefined
    ? {
      kind: 'command' as const,
      seq: checkpoint.event.seq,
      time: checkpoint.event.time,
      commandId: source.sourceCommandId,
      name: 'compact',
      args: null,
      outcome: null,
    }
    : { ...commandFromDone(done), name: 'compact' }
  return {
    command: fallbackCommand,
    checkpoint,
    ...summary === undefined ? {} : { summary },
  }
}

/**
 * Fold shared compaction evidence into a Definition-owned State.
 * @param state - current business State carrying optional compaction evidence.
 * @param match - next compaction lifecycle Match.
 * @returns adopted State, preserving reference identity when the Match adds no evidence.
 */
export function updateCompactionState<State extends CompactionEvidence>(
  state: State,
  match: ConversationMatch,
): State {
  if (isSessionEvent(match.event, 'compaction/progress') && (state.end || state.presentation?.phase === 'failed' || state.presentation?.phase === 'succeeded')) return state
  const presentation = projectedCompactionView(match.view)
  let next = state
  if (isSessionEvent(match.event, 'compaction/start')) next = { ...state, start: match, end: undefined }
  else if (isSessionEvent(match.event, 'compaction/progress')) next = state.end ? state : { ...state, progress: match }
  else if (isSessionEvent(match.event, 'compaction/end')) next = { ...state, presentation: undefined, end: match }
  else if (isSessionEvent(match.event, 'compaction/summary')) next = { ...state, summary: match }
  else if (compactSource(match.event) !== undefined) next = { ...state, checkpoint: match }
  return presentation === undefined ? next : { ...next, presentation }
}

/** Slash-command lifecycle, including integrated manual compaction, Definition. */
export const commandDefinition: ConversationNodeDefinition<CommandState> = {
  historyReuse: 'local',
  kind: 'command',
  target: 'chat',
  match: (event, view) => {
    const projected = projectedCompactionView(view)
    if (typeof projected?.sourceCommandId === 'string') return { id: projected.sourceCommandId, role: 'update' }
    validateCompactionEvent(event)
    if (isSessionEvent(event, 'command/run')) {
      return { id: String(event.data.commandId), role: 'start' }
    }
    if (isSessionEvent(event, 'command/done')) {
      return { id: String(event.data.commandId), role: 'update' }
    }
    const checkpoint = compactSource(event)
    if (checkpoint?.sourceCommandId !== undefined) {
      return { id: String(checkpoint.sourceCommandId), role: 'update' }
    }
    if (isSessionEvent(event, 'compaction/start')
      || isSessionEvent(event, 'compaction/progress')
      || isSessionEvent(event, 'compaction/summary')
      || isSessionEvent(event, 'compaction/end')) {
      if (event.data.sourceCommandId !== undefined) {
        return { id: String(event.data.sourceCommandId), role: 'update' }
      }
    }
    return null
  },
  start: (_context, match) => {
    if (isSessionEvent(match.event, 'command/run')) return { command: commandFromRun(match) }
    if (isSessionEvent(match.event, 'command/done')) return { command: commandFromDone(match) }
    const view = projectedCompactionView(match.view)
    const sourceCommandId = view?.sourceCommandId ?? sourceCommandIdOf(match)
    if (sourceCommandId === undefined) throw new Error('manual compaction requires command identity')
    const command: CommandNode = { kind: 'command', seq: view?.anchorSeq ?? match.event.seq, time: view?.time ?? match.event.time,
      commandId: sourceCommandId, name: 'compact', args: null, outcome: null }
    return updateCompactionState<CommandState>({ command }, match)
  },
  update: (context, match) => {
    if (isSessionEvent(match.event, 'command/done')) {
      return { ...context.state, command: commandFromDone(match, context.state.command) }
    }
    return updateCompactionState(context.state, match)
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    if (state.command.name !== 'compact') {
      return chatNode(context, 'command', state.command.seq, state.command)
    }
    const compaction = state.checkpoint === undefined
      ? compactLifecycle(state)
      : { ...compactSummary(state.summary, state.checkpoint), progress: compactProgress(isSessionEvent(state.progress?.event, 'compaction/progress') ? state.progress.event.data.progress : undefined) }
    const data: ManualCompactionChatData = { command: state.command, compaction }
    return chatNode(context, 'manual-compaction', compaction?.seq ?? state.command.seq, data)
  },
}

/**
 * Register the command lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCommandConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(commandDefinition)
}

/** Shared structural checkpoint recognizer for automatic compaction. */
export { compactSource, compactSummary }

function sourceCommandIdOf(match: ConversationMatch): string | undefined {
  const value = match.event.data
  return typeof value === 'object' && value !== null && 'sourceCommandId' in value && typeof value.sourceCommandId === 'string' ? value.sourceCommandId : undefined
}
