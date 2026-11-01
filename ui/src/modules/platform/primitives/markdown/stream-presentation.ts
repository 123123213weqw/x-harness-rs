/** Display-only pacing. Never changes the conversation's source text or control events. */
export const STREAM_BATCH_MS = 32
export const STREAM_FADE_MS = 150
export const STREAM_BURST_LIMIT = 8192
export const STREAM_CATCHUP_MS = 192
export const STREAM_FINISH_MS = 96
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
  private target: string
  private deadline = 0
  private lastTick = 0
  private streaming = false
  private readonly segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

  constructor(text: string) {
    // Restored/mounted content is already visible, not a new append.
    this.frame = { text, ranges: [] }
    this.target = text
  }

  get wasStreaming(): boolean { return this.streaming }
  get pending(): boolean { return this.frame.text !== this.target }
  isAppend(text: string): boolean { return text.startsWith(this.target) }
  nextDelay(now: number): number { return Math.min(STREAM_BATCH_MS, Math.max(0, this.deadline - now)) }

  /** New arrivals never move an existing debt deadline further away. */
  receive(text: string, now: number, animate: boolean, streaming = true): StreamFrame {
    const wasStreaming = this.streaming
    this.streaming = streaming
    if (!animate || this.segmenter === null || (!streaming && !wasStreaming && !this.pending) || !text.startsWith(this.target) || text.length - this.frame.text.length > STREAM_BURST_LIMIT) {
      return this.commit(text, now, false)
    }
    if (!this.pending && text !== this.target) {
      this.deadline = now + STREAM_CATCHUP_MS
      this.lastTick = now
    }
    this.target = text
    if (!streaming && this.pending) this.deadline = Math.min(this.deadline, now + STREAM_FINISH_MS)
    return this.frame
  }

  /** Adaptive catch-up, bounded in time rather than a fixed characters/second queue. */
  tick(now: number): StreamFrame {
    if (!this.pending || now <= this.lastTick) return this.frame
    const start = this.frame.text.length
    const remaining = this.target.length - start
    const fraction = Math.min(1, (now - this.lastTick) / Math.max(1, this.deadline - this.lastTick))
    const desired = start + Math.max(1, Math.ceil(remaining * fraction))
    let end = desired
    if (desired < this.target.length && this.segmenter !== null) {
      // Only the bounded unpublished tail is segmented, never the whole chat.
      for (const part of this.segmenter.segment(this.target.slice(start))) {
        end = start + part.index + part.segment.length
        if (end >= desired) break
      }
    } else {
      while (end < this.target.length && !safeBoundary(this.target, end)) end++
    }
    this.lastTick = now
    return this.publish(this.target.slice(0, end), now, true)
  }

  /** Immediate bypass for history, replacement, interruption and inaccessible animation. */
  commit(text: string, now: number, animate: boolean): StreamFrame {
    this.target = text
    this.deadline = this.lastTick = now
    return this.publish(text, now, animate)
  }

  private publish(text: string, now: number, animate: boolean): StreamFrame {
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
  const before = text.slice(Math.max(0, offset - 2), offset).match(/.$/u)?.[0] ?? ''
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
