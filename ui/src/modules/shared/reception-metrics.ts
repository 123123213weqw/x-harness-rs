import { isObjectRecord } from './runtime-types'

/** Pure metric arithmetic shared by Chat and Performance. Never reads UI time. */
export function throughput(tokens: number, milliseconds: number): number | null {
  return Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(milliseconds) && milliseconds > 0
    ? tokens / (milliseconds / 1000) : null
}
export function totalOutputTokens(usage: unknown): number | null {
  if (!isObjectRecord(usage)) return null
  const output = usage.outputTokens
  const reasoning = usage.reasoningTokens ?? 0
  return typeof output === 'number' && Number.isFinite(output) && output >= 0
    && typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0 ? output + reasoning : null
}
export function messageProvenance(message: unknown): { provider: string; model: string } | undefined {
  if (!isObjectRecord(message) || !isObjectRecord(message.source)) return undefined
  const { provider, model } = message.source
  return typeof provider === 'string' && typeof model === 'string' ? { provider,model } : undefined
}
export interface ReceptionReading {
  turn: number; step: number; attempt: number; startMs: number; firstDeltaMs: number | null
  elapsedMs: number; receptionMs: number; finished: boolean
}
export function receptionReading(event: { type: string; data: unknown } | undefined): ReceptionReading | null {
  if (event?.type !== 'model/reception' || !isObjectRecord(event.data)) return null
  const data = event.data, r = data.reception
  if (!isObjectRecord(r)) return null
  const { turn, step } = data
  const { attempt, startMs, firstDeltaMs, elapsedMs, receptionMs, finished } = r
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!finite(turn) || !finite(step) || !finite(attempt) || !finite(startMs) || !finite(elapsedMs)
    || !finite(receptionMs) || receptionMs < 1 || typeof finished !== 'boolean'
    || !(firstDeltaMs === null || finite(firstDeltaMs) && firstDeltaMs >= startMs)) return null
  return { turn, step, attempt, startMs, firstDeltaMs, elapsedMs, receptionMs, finished }
}
