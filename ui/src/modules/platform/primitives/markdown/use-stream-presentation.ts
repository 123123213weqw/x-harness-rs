import { useLayoutEffect, useRef, useState } from 'react'
import { STREAM_BURST_LIMIT, StreamPresentation } from './stream-presentation'
import type { StreamFrame } from './stream-presentation'

/** A bounded presentation queue, separate from canonical text and completion state. */
export function useStreamPresentation(text: string, enabled: boolean, streaming = true): StreamFrame {
  const model = useRef<StreamPresentation | null>(null)
  if (model.current === null) model.current = new StreamPresentation(text)
  const [frame, setFrame] = useState(model.current.frame)
  const latest = useRef({ text, enabled, streaming })
  latest.current = { text, enabled, streaming }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reduced = useRef(false)
  const alive = useRef(false)

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  const flush = (): void => {
    cancel()
    if (alive.current && model.current !== null) setFrame(model.current.commit(latest.current.text, Date.now(), false))
  }
  const schedule = (): void => {
    if (timer.current !== null || !model.current?.pending) return
    timer.current = setTimeout(() => {
      timer.current = null
      if (!alive.current || model.current === null) return
      if (!latest.current.enabled || document.hidden || reduced.current) { flush(); return }
      setFrame(model.current.tick(Date.now()))
      schedule()
    }, model.current.nextDelay(Date.now()))
  }

  useLayoutEffect(() => {
    alive.current = true
    if (!enabled) return () => { alive.current = false; cancel() }
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    reduced.current = media?.matches === true
    const bypass = (): void => { reduced.current = media?.matches === true; flush() }
    document.addEventListener('visibilitychange', bypass)
    media?.addEventListener('change', bypass)
    return () => {
      alive.current = false
      cancel()
      document.removeEventListener('visibilitychange', bypass)
      media?.removeEventListener('change', bypass)
    }
  }, [enabled])

  useLayoutEffect(() => {
    if (model.current === null) return
    const animate = enabled && !document.hidden && !reduced.current
    setFrame(model.current.receive(text, Date.now(), animate, streaming))
    if (model.current.pending) schedule()
    else cancel()
  }, [text, enabled, streaming])

  // Replacement, stop and huge bursts paint the exact source in this render.
  // Normal completion may drain only the last <=96ms of display debt; it never
  // delays the authoritative completed state or another tool/control event.
  return !enabled || (!streaming && !model.current.wasStreaming && !model.current.pending) || document.hidden || reduced.current || !model.current.isAppend(text) || text.length - frame.text.length > STREAM_BURST_LIMIT
    ? { text, ranges: [] }
    : frame
}
