/** Display-only stream batching. Never changes the conversation's source text. */
export const STREAM_BATCH_MS = 50
export const STREAM_FADE_MS = 150
export const STREAM_BURST_LIMIT = 1024
const MAX_RECENT_BATCHES = 4

export interface StreamRange {
  readonly start: number
  readonly end: number
  readonly at: number
}

export interface StreamFrame {
  readonly text: string
  readonly ranges: readonly StreamRange[]
}

/** Bounded recent append ranges; old text never gets a new animation identity. */
export class StreamPresentation {
  frame: StreamFrame

  constructor(text: string) {
    // Restored/mounted content is already visible, not a new append.
    this.frame = { text, ranges: [] }
  }

  commit(text: string, now: number, animate: boolean): StreamFrame {
    const old = this.frame
    if (text === old.text && (animate || old.ranges.length === 0)) return old
    const appended = text.length - old.text.length
    const ranges = animate && appended > 0 && appended <= STREAM_BURST_LIMIT && text.startsWith(old.text)
      ? [...old.ranges.filter(range => now - range.at < STREAM_FADE_MS), { start: old.text.length, end: text.length, at: now }].slice(-MAX_RECENT_BATCHES)
      : []
    return (this.frame = { text, ranges })
  }
}

export interface StreamPiece {
  readonly text: string
  readonly start: number
  readonly at?: number
}

/** Do not put element boundaries inside surrogate pairs or joined graphemes. */
function safeBoundary(text: string, offset: number): boolean {
  if (offset === 0 || offset === text.length) return true
  const before = text.slice(0, offset).match(/.$/u)?.[0] ?? ''
  const after = text.slice(offset).match(/^./u)?.[0] ?? ''
  return !(/[\uD800-\uDBFF]$/.test(before) && /^[\uDC00-\uDFFF]/.test(after))
    && !/^[\p{M}\u200d\ufe0e\ufe0f\u{1f3fb}-\u{1f3ff}]/u.test(after)
    && before !== '\u200d'
    && !(/[\u{1f1e6}-\u{1f1ff}]/u.test(before) && /[\u{1f1e6}-\u{1f1ff}]/u.test(after))
}

/** Split only exact prose-source matches. Escaped/entity-normalized text stays plain. */
export function streamPieces(value: string, offset: number, frame: StreamFrame, now: number, end = offset + value.length): StreamPiece[] {
  const plain = [{ text: value, start: offset }]
  if (offset < 0 || end - offset !== value.length || frame.text.slice(offset, end) !== value) return plain
  const ranges = frame.ranges.filter(range => range.end > offset && range.start < end && now - range.at < STREAM_FADE_MS)
  if (ranges.length === 0) return plain
  const pieces: StreamPiece[] = []
  let cursor = offset
  for (const range of ranges) {
    const start = Math.max(range.start, offset)
    const stop = Math.min(range.end, end)
    if (!safeBoundary(value, start - offset) || !safeBoundary(value, stop - offset)) return plain
    if (start > cursor) pieces.push({ text: value.slice(cursor - offset, start - offset), start: cursor })
    pieces.push({ text: value.slice(start - offset, stop - offset), start, at: range.at })
    cursor = stop
  }
  if (cursor < end) pieces.push({ text: value.slice(cursor - offset), start: cursor })
  return pieces
}
