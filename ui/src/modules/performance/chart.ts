import type { Sample, Turn, Request } from './contract'
import { throughput } from '../shared/reception-metrics'
export type Track = 'textUnits' | 'reasoningUnits' | 'argumentUnits'
export function sampleTps(sample: Sample, track?: Track, request?: Request): number {
  const raw = (n: number) => n / 4
  if (request?.reportedOutputTokens === null || request?.reportedOutputTokens === undefined
    || request.estimatedUnits === undefined || request.estimatedUnits <= 0) {
    return raw(track === undefined ? sample.textUnits + sample.reasoningUnits + sample.argumentUnits : sample[track])
  }
  const output = request.reportedOutputTokens
  const total = output + (request.reportedReasoningTokens ?? 0)
  const reasoning = request.estimatedReasoningUnits
  // Detailed reasoning usage must not manufacture a curve for hidden thought.
  // Without a reported split, calibration preserves the observed total shape.
  if (reasoning === undefined || !(request.reportedReasoningTokens ?? 0)) {
    return (track === undefined ? sample.textUnits + sample.reasoningUnits + sample.argumentUnits : sample[track]) * total / request.estimatedUnits
  }
  const visible = request.estimatedUnits - reasoning
  const rate = (kind: Track) => kind === 'reasoningUnits'
    ? (reasoning > 0 ? sample[kind] * (request.reportedReasoningTokens ?? 0) / reasoning : 0)
    : (visible > 0 ? sample[kind] * output / visible : 0)
  return track === undefined ? rate('textUnits') + rate('reasoningUnits') + rate('argumentUnits') : rate(track)
}
/** No interpolation across steps, retries, or missing reception seconds. */
export function series(turn: Turn, track: Track, smooth: boolean): readonly (readonly Sample[])[] {
  const segments: Sample[][] = []
  for (const sample of turn.samples) {
    let segment = segments.at(-1), last = segment?.at(-1)
    if (last === undefined || last.step !== sample.step || last.attempt !== sample.attempt || sample.timeMs - last.timeMs !== 1000) {
      segment = []; segments.push(segment)
    }
    if (segment !== undefined) segment.push(sample)
  }
  if (!smooth) return segments
  return segments.map(segment => segment.map((sample, i) => ({ ...sample,
    [track]: segment.slice(Math.max(0,i-2),i+1).reduce((n,s)=>n+s[track],0) / Math.min(3,i+1),
  })))
}
export function nearest(turn: Turn, timeMs: number): Sample | undefined {
  return turn.samples.reduce<Sample | undefined>((best,s)=>best === undefined || Math.abs(s.timeMs-timeMs) < Math.abs(best.timeMs-timeMs) ? s : best,undefined)
}
export function reportedTps(turn: Turn): number | null {
  let tokens = 0, milliseconds = 0
  const route = turn.requests.at(-1)
  for (const request of turn.requests) {
    if (route !== undefined && (request.provider !== route.provider || request.model !== route.model)) continue
    if (request.reportedOutputTokens === null || request.firstDeltaMs === null || request.endMs === null) continue
    const span = request.receptionMs ?? (request.endMs > request.firstDeltaMs ? request.endMs-request.firstDeltaMs : Math.max(1,request.endMs-request.startMs))
    tokens += request.reportedOutputTokens + (request.reportedReasoningTokens ?? 0)
    milliseconds += span
  }
  return throughput(tokens,milliseconds)
}
