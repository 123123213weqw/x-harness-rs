/** Presentation-only pacing. Character growth is a visual proxy, not model TPS. */
export const REASONING_FAST_CHARS_PER_SECOND = 120
export const REASONING_PAGE_MS = 800
export const REASONING_FLIP_MS = 180
const RATE_WINDOW_MS = 1000
const RATE_BUCKET_MS = 100
const MIN_RATE_SAMPLE_MS = 200
const SLOW_CHARS_PER_SECOND = 80

export function firstReasoningLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

export function latestReasoningLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

function pageExcerpt(text: string): string {
  const visible = text.trimEnd()
  let line = latestReasoningLine(visible)
  // A just-started line can be only one character. Prefer the previous complete
  // line until there is a readable fragment, rather than flipping to a lone word.
  const newline = visible.lastIndexOf('\n')
  if (line.length < 8 && newline >= 0) line = latestReasoningLine(visible.slice(0, newline))
  // Only the compact preview is abbreviated; the reasoning body stays exact.
  const tail = Array.from(line.slice(-320)).slice(-160).join('')
  return tail.length < line.length ? `…${tail}` : line
}

export interface ReasoningSummaryFrame {
  readonly current: string
  readonly previous: string | undefined
  readonly paging: boolean
  readonly revision: number
  readonly at: number
}

/** At most two visible lines, eleven rate buckets, and no queue of old pages. */
export class ReasoningSummaryPresentation {
  input: string
  frame: ReasoningSummaryFrame
  private startedAt: number
  private now: number
  private nextPageAt: number | undefined
  private buckets: { at: number; count: number }[] = []

  constructor(text: string, now: number) {
    this.input = text
    this.startedAt = this.now = now
    this.frame = { current: latestReasoningLine(text), previous: undefined, paging: false, revision: 0, at: now }
  }

  reset(text: string, now: number): ReasoningSummaryFrame {
    this.input = text
    this.startedAt = this.now = now
    this.buckets = []
    this.nextPageAt = undefined
    this.frame = { current: latestReasoningLine(text), previous: undefined, paging: false, revision: this.frame.revision + 1, at: now }
    return this.frame
  }

  update(text: string, now: number, animate: boolean): ReasoningSummaryFrame {
    if (!text.startsWith(this.input)) return this.reset(text, now)
    const growth = text.length - this.input.length
    this.input = text
    this.now = Math.max(this.now, now)
    if (growth > 0) {
      const at = Math.floor(this.now / RATE_BUCKET_MS) * RATE_BUCKET_MS
      const last = this.buckets[this.buckets.length - 1]
      if (last?.at === at) last.count += growth
      else this.buckets.push({ at, count: growth })
    }
    return this.advance(this.now, animate)
  }

  advance(now: number, animate: boolean): ReasoningSummaryFrame {
    this.now = Math.max(this.now, now)
    this.buckets = this.buckets.filter(bucket => bucket.at > this.now - RATE_WINDOW_MS)
    const elapsed = Math.min(RATE_WINDOW_MS, this.now - this.startedAt)
    const rate = this.buckets.reduce((sum, bucket) => sum + bucket.count, 0) * 1000 / Math.max(MIN_RATE_SAMPLE_MS, elapsed)
    const paging = elapsed >= MIN_RATE_SAMPLE_MS && rate >= (this.frame.paging ? SLOW_CHARS_PER_SECOND : REASONING_FAST_CHARS_PER_SECOND)
    if (!paging) {
      const current = latestReasoningLine(this.input)
      this.nextPageAt = undefined
      if (this.frame.paging || this.frame.previous !== undefined || current !== this.frame.current) {
        this.frame = { current, previous: undefined, paging: false, revision: this.frame.revision + 1, at: this.now }
      }
      return this.frame
    }
    if (!this.frame.paging) {
      this.nextPageAt = this.now + REASONING_PAGE_MS
      this.frame = { current: pageExcerpt(this.input), previous: undefined, paging: true, revision: this.frame.revision + 1, at: this.now }
    } else if (this.now >= (this.nextPageAt ?? this.now)) {
      // A delayed browser callback skips straight to the newest page, never replays a backlog.
      this.nextPageAt = this.now + REASONING_PAGE_MS
      const current = pageExcerpt(this.input)
      if (current !== this.frame.current) {
        this.frame = { current, previous: animate ? this.frame.current : undefined, paging: true, revision: this.frame.revision + 1, at: this.now }
      }
    }
    if (this.frame.previous !== undefined && (!animate || this.now - this.frame.at >= REASONING_FLIP_MS)) {
      this.frame = { ...this.frame, previous: undefined }
    }
    return this.frame
  }

  /** The hook owns one timer: either expire the outgoing line or show the latest page. */
  get nextAt(): number | undefined {
    return this.frame.previous === undefined ? this.nextPageAt : Math.min(this.frame.at + REASONING_FLIP_MS, this.nextPageAt ?? Infinity)
  }
}
