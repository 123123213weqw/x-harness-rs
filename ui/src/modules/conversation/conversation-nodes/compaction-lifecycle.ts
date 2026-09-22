import { compactionTerminalPhase, isCompactionEndOutcome, validCompactionTerminalData, type CompactionEndOutcome } from '../../shared/compaction-outcome'
import { isSessionEvent } from '../contract/wire-event-codec'
import type { ConversationMatch, CompactionSummaryNode, ToolEventView } from '../types/runtime'

export interface CompactionProgress {
  stage: 'preparing' | 'summarizing' | 'splitting' | 'merging' | 'retrying' | 'paused' | 'validating' | 'committing'
  calls: number
  completedParts: number
  splits: number
  retries: number
  delayMs?: number | null | undefined
  inputTokensBefore?: number | null | undefined
  inputTokensAfter?: number | null | undefined
}
interface PresentationBase {
  id: string
  anchorSeq: number
  time: number
  sourceCommandId?: string | undefined
  progress?: (unknown) | undefined
  progressTime?: number | undefined
  startedAt?: number | undefined
  endedAt?: number | undefined
  error?: string | null | undefined
  outcome?: CompactionEndOutcome | undefined
}
export type CompactionPresentation = PresentationBase & (
  | { phase: 'running' | 'failed' | 'skipped' | 'cancelled' }
  | { phase: 'succeeded'; summary: string; summaryEventSeq: number; shadowedItemCount: number; shadowedTokenCount: number }
)
export interface CompactionPendingNode {
  kind: 'compaction'
  status: 'running' | 'failed' | 'skipped' | 'cancelled'
  seq: number
  time: number
  progress?: CompactionProgress | undefined
  progressTime?: number | undefined
  error: string | null
  outcome?: CompactionEndOutcome | undefined
  endedAt?: number | undefined
}
export type CompactionNode = CompactionSummaryNode | CompactionPendingNode
export interface CompactionEvidence {
  readonly start?: ConversationMatch | undefined
  readonly end?: ConversationMatch | undefined
  readonly progress?: ConversationMatch | undefined
  readonly summary?: ConversationMatch | undefined
  readonly checkpoint?: ConversationMatch | undefined
  readonly presentation?: CompactionPresentation | undefined
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function progressStage(value: unknown): value is CompactionProgress['stage'] {
  return value === 'preparing' || value === 'summarizing' || value === 'splitting' || value === 'merging'
    || value === 'retrying' || value === 'paused' || value === 'validating' || value === 'committing'
}
function isCompactProgress(value: unknown): value is CompactionProgress {
  if (!record(value) || !progressStage(value.stage)) return false
  if (!count(value.calls) || !count(value.completedParts) || !count(value.splits) || !count(value.retries)) return false
  if (value.completedParts > value.calls) return false
  for (const key of ['delayMs', 'inputTokensBefore', 'inputTokensAfter']) if (value[key] != null && !count(value[key])) return false
  return true
}
export function compactProgress(value: unknown): CompactionProgress | undefined {
  return isCompactProgress(value) ? value : undefined
}

/** xh-compaction-view-model/v2: validated wire presentation survives history cuts. */
export function projectedCompactionView(envelope: ToolEventView | undefined): CompactionPresentation | undefined {
  if (envelope?.for !== 'compaction' || envelope.view.schemaVersion !== 1) return undefined
  const view = envelope.view
  if (view.outcome !== undefined && !isCompactionEndOutcome(view.outcome)) return undefined
  if (view.outcome !== undefined && (!validCompactionTerminalData({ outcome: view.outcome, error: typeof view.error === 'string' || view.error === null ? view.error : undefined }) || (view.error !== undefined && view.error !== null && typeof view.error !== 'string'))) return undefined
  if (view.outcome !== undefined && (view.phase === 'running' || view.phase !== compactionTerminalPhase(view.outcome, typeof view.error === 'string' ? view.error : undefined))) return undefined
  if (typeof view.id !== 'string' || view.id === '' || !count(view.anchorSeq) || typeof view.time !== 'number' || !Number.isFinite(view.time)) return undefined
  const base: PresentationBase = { id: view.id, anchorSeq: view.anchorSeq, time: view.time, progress: view.progress,
    ...(typeof view.sourceCommandId === 'string' ? { sourceCommandId: view.sourceCommandId } : {}),
    ...(typeof view.progressTime === 'number' ? { progressTime: view.progressTime } : {}),
    ...(typeof view.startedAt === 'number' ? { startedAt: view.startedAt } : {}),
    ...(typeof view.endedAt === 'number' ? { endedAt: view.endedAt } : {}),
    ...(typeof view.error === 'string' || view.error === null ? { error: view.error } : {}),
    ...(isCompactionEndOutcome(view.outcome) ? { outcome: view.outcome } : {}),
  }
  if (view.phase === 'running' || view.phase === 'failed' || view.phase === 'skipped' || view.phase === 'cancelled') return { ...base, phase: view.phase }
  if (view.phase !== 'succeeded' || typeof view.summary !== 'string' || !count(view.summaryEventSeq) || !count(view.shadowedItemCount) || !count(view.shadowedTokenCount)) return undefined
  return { ...base, phase: view.phase, summary: view.summary, summaryEventSeq: view.summaryEventSeq, shadowedItemCount: view.shadowedItemCount, shadowedTokenCount: view.shadowedTokenCount }
}

/** Minimal durable lifecycle. No browser progress simulation or per-row timers. */
export function compactLifecycle(state: CompactionEvidence): CompactionNode | null {
  const view = state.presentation, start = state.start?.event, end = state.end?.event, update = state.progress?.event
  const progress = compactProgress(view?.progress ?? (isSessionEvent(update, 'compaction/progress') ? update.data.progress : undefined))
  if (view?.phase === 'succeeded') return { kind: 'compaction', seq: view.anchorSeq, time: view.time, summary: view.summary,
    summaryEventSeq: view.summaryEventSeq, shadowedItemCount: view.shadowedItemCount, shadowedTokenCount: view.shadowedTokenCount,
    progress, startedAt: view.startedAt, endedAt: view.endedAt,
  }
  if (!view && !start) return null
  const rawEnd = isSessionEvent(end, 'compaction/end') ? end.data : undefined
  const outcome = view?.outcome ?? rawEnd?.outcome
  const terminal = compactionTerminalPhase(outcome, view?.error ?? rawEnd?.error)
  // A succeeded raw end still needs its checkpoint; do not manufacture a
  // committed summary if a legacy page is missing replacement evidence.
  const status = view?.phase ?? (end ? terminal === 'succeeded' ? 'failed' : terminal : 'running')
  return { kind: 'compaction', status,
    seq: view?.anchorSeq ?? start?.seq ?? 0, time: view?.time ?? start?.time ?? 0, progress,
    progressTime: view?.progressTime ?? update?.time,
    error: view?.error ?? rawEnd?.error ?? null,
    ...(outcome === undefined ? {} : { outcome }),
    endedAt: view?.endedAt ?? end?.time,
  }
}
