import type { Sample, Turn } from './contract'
export type Track = 'textUnits' | 'reasoningUnits' | 'argumentUnits'
export function sampleTps(sample: Sample, track?: Track): number {
  return (track === undefined ? sample.textUnits + sample.reasoningUnits + sample.argumentUnits : sample[track]) / 4
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
  for (const request of turn.requests) {
    if (request.reportedOutputTokens === null || request.firstDeltaMs === null || request.endMs === null || request.endMs <= request.firstDeltaMs) continue
    tokens += request.reportedOutputTokens + (request.reportedReasoningTokens ?? 0)
    milliseconds += request.endMs-request.firstDeltaMs
  }
  return milliseconds === 0 ? null : tokens/(milliseconds/1000)
}
