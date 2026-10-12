/** v1 is verified against the Rust-generated shared wire fixture in both suites. */
export const PHASES = ['preparing','waiting_first_token','reasoning','output','arguments','tool','approval','question','retry','compaction','between_steps','unknown'] as const
export type PhaseKind = typeof PHASES[number]
export interface Sample { timeMs: number; step: number; attempt: number; textUnits: number; reasoningUnits: number; argumentUnits: number }
export interface Phase { startMs: number; endMs: number | null; kind: PhaseKind; step: number | null; attempt: number }
export interface Request { step: number; attempt: number; startMs: number; firstDeltaMs: number | null; endMs: number | null; provider: string | null; model: string | null; reportedOutputTokens: number | null; reportedReasoningTokens: number | null }
export interface Turn { turn: number; startMs: number; endMs: number | null; lastMs: number; truncated: boolean; samples: readonly Sample[]; phases: readonly Phase[]; requests: readonly Request[] }
export interface Timeline { schemaVersion: 1; source: 'journal_checkpoint_estimate'; bucketMs: 1000; maxSamples: 600; turns: readonly Turn[] }
declare module '../client-connection/contracts/session/session-projection/types' { interface SessionProjectionMap { performanceTimeline: Timeline } }

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !array(v)
const array = (v: unknown): v is unknown[] => Array.isArray(v)
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const nullable = (v: unknown): v is number | null => v === null || integer(v)
const ordered = (start: unknown, end: unknown) => integer(start) && nullable(end) && (end === null || end >= start)
/** Invalid optional telemetry disables only this panel, never Session history. */
function isTimeline(value: unknown): value is Timeline {
  if (!record(value) || value.schemaVersion !== 1 || value.source !== 'journal_checkpoint_estimate'
    || value.bucketMs !== 1000 || value.maxSamples !== 600 || !array(value.turns) || value.turns.length > 4) return false
  let samples = 0, phases = 0, requests = 0, previousTurn = -1
  for (const turn of value.turns) {
    if (!record(turn) || !integer(turn.turn) || turn.turn <= previousTurn || !integer(turn.startMs) || !ordered(turn.startMs,turn.endMs)
      || !integer(turn.lastMs) || turn.lastMs < turn.startMs || (turn.endMs !== null && (!integer(turn.endMs) || turn.endMs > turn.lastMs)) || typeof turn.truncated !== 'boolean'
      || !array(turn.samples) || !array(turn.phases) || !array(turn.requests)) return false
    previousTurn = turn.turn
    samples += turn.samples.length; phases += turn.phases.length; requests += turn.requests.length
    let lastTime = -1
    for (const sample of turn.samples) {
      if (!record(sample) || !integer(sample.timeMs) || sample.timeMs % 1000 !== 0 || sample.timeMs < lastTime || sample.timeMs > turn.lastMs || sample.timeMs + 999 < turn.startMs
        || ![sample.step,sample.attempt,sample.textUnits,sample.reasoningUnits,sample.argumentUnits].every(integer)) return false
      lastTime = sample.timeMs
    }
    for (const phase of turn.phases) if (!record(phase) || !ordered(phase.startMs,phase.endMs)
      || !nullable(phase.step) || !integer(phase.attempt) || !PHASES.some(kind => kind === phase.kind)) return false
    for (const request of turn.requests) if (!record(request) || !integer(request.step) || !integer(request.attempt)
      || !ordered(request.startMs,request.endMs) || !ordered(request.startMs,request.firstDeltaMs)
      || !nullable(request.reportedOutputTokens) || !nullable(request.reportedReasoningTokens)
      || ![request.provider,request.model].every(v => v === null || (typeof v === 'string' && v.length <= 320))) return false
  }
  if (samples > 600 || phases > 128 || requests > 64) return false
  return true
}

export function readTimeline(value: unknown): Timeline | null { return isTimeline(value) ? value : null }
