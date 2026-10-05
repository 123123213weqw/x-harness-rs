import { useLayoutEffect, useRef, useState } from 'react'
import { latestReasoningLine, ReasoningSummaryPresentation, type ReasoningSummaryFrame } from './reasoning-summary'

/** Only the running, collapsed preview is paced. History and expanded text are not. */
export function useReasoningSummary(text: string, enabled: boolean): ReasoningSummaryFrame {
  const model = useRef<ReasoningSummaryPresentation | null>(null)
  model.current ??= new ReasoningSummaryPresentation(text, Date.now())
  const presentation = model.current
  const [frame, setFrame] = useState(presentation.frame)
  const input = useRef(text)
  input.current = text
  const controls = useRef({ active: false, hidden: false, reduce: false })
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const publish = useRef<() => void>(() => {})

  const cancel = (): void => {
    if (pending.current !== null) clearTimeout(pending.current)
    pending.current = null
  }
  publish.current = () => {
    const current = presentation
    setFrame(current.frame)
    const nextAt = current.nextAt
    if (!controls.current.active || controls.current.hidden || nextAt === undefined || pending.current !== null) return
    pending.current = setTimeout(() => {
      pending.current = null
      if (!controls.current.active || controls.current.hidden) return
      current.advance(Date.now(), !controls.current.reduce)
      publish.current()
    }, Math.max(0, nextAt - Date.now()))
  }

  useLayoutEffect(() => {
    controls.current.active = enabled
    if (!enabled) { cancel(); presentation.reset(input.current, Date.now()); setFrame(presentation.frame); return }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (): void => {
      cancel()
      const wasHidden = controls.current.hidden
      controls.current.hidden = document.hidden
      controls.current.reduce = media.matches
      if (wasHidden || document.hidden) presentation.reset(input.current, Date.now())
      else presentation.advance(Date.now(), !media.matches)
      publish.current()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    media.addEventListener('change', sync)
    return () => {
      controls.current.active = false
      cancel()
      document.removeEventListener('visibilitychange', sync)
      media.removeEventListener('change', sync)
    }
  }, [enabled])

  useLayoutEffect(() => {
    if (!enabled) return
    if (controls.current.hidden) presentation.reset(text, Date.now())
    else presentation.update(text, Date.now(), !controls.current.reduce)
    // Do not restart the 800ms deadline for each incoming chunk.
    if (presentation.nextAt === undefined) cancel()
    publish.current()
  }, [text, enabled])

  // Finish, expansion, and replacement cannot paint a stale page even for one frame.
  if (!enabled || !text.startsWith(presentation.input) || controls.current.hidden || !frame.paging) {
    return { current: latestReasoningLine(text), previous: undefined, paging: false, revision: frame.revision, at: frame.at }
  }
  return frame
}
