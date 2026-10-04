import { useLayoutEffect, useRef, useState } from 'react'
import { STREAM_BATCH_MS, STREAM_BURST_LIMIT, StreamPresentation } from './stream-presentation'
import type { StreamFrame } from './stream-presentation'

/** Coalesce tiny live appends without restarting the deadline on every token. */
export function useStreamPresentation(text: string, enabled: boolean): StreamFrame {
  const model = useRef<StreamPresentation | null>(null)
  if (model.current === null) model.current = new StreamPresentation(text)
  const [frame, setFrame] = useState(model.current.frame)
  const latest = useRef({ text, enabled })
  latest.current = { text, enabled }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reduced = useRef(false)
  const alive = useRef(false)

  const flush = (animate: boolean): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    if (!alive.current || model.current === null) return
    const next = model.current.commit(latest.current.text, Date.now(), animate)
    setFrame(next)
  }

  useLayoutEffect(() => {
    alive.current = true
    if (!enabled) return () => { alive.current = false }
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    reduced.current = media?.matches === true
    const bypass = (): void => { reduced.current = media?.matches === true; flush(false) }
    document.addEventListener('visibilitychange', bypass)
    media?.addEventListener('change', bypass)
    return () => {
      alive.current = false
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      document.removeEventListener('visibilitychange', bypass)
      media?.removeEventListener('change', bypass)
    }
  }, [enabled])

  useLayoutEffect(() => {
    const previous = model.current?.frame.text ?? ''
    if (!enabled || document.hidden || reduced.current || !text.startsWith(previous) || text.length - previous.length > STREAM_BURST_LIMIT) {
      flush(false)
    } else if (text !== previous && timer.current === null) {
      timer.current = setTimeout(() => flush(latest.current.enabled && !document.hidden && !reduced.current), STREAM_BATCH_MS)
    }
  }, [text, enabled])

  // End/interruption/replacement must paint the exact source in this render,
  // not a stale prefix while waiting for an effect or background timer.
  return !enabled || !text.startsWith(frame.text) || text.length - frame.text.length > STREAM_BURST_LIMIT
    ? { text, ranges: [] }
    : frame
}
