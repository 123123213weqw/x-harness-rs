import { useLayoutEffect, useRef, useState } from 'react'
import { EMPTY_TOOL_ACTIVITY, ToolActivityPresentation, type ToolActivitySelection, type ToolActivityFrame } from './tool-activity'

/** One timer per mounted live header; no ticking clock or per-call subscription. */
export function useToolActivity(input: ToolActivitySelection, enabled: boolean, paused: boolean): ToolActivityFrame {
  const model = useRef<ToolActivityPresentation | null>(null)
  model.current ??= new ToolActivityPresentation()
  const presentation = model.current
  const [frame, setFrame] = useState(presentation.frame)
  const latest = useRef(input); latest.current = input
  const controls = useRef({ active: false, hidden: false, reduce: false, paused: false })
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const publish = useRef<() => void>(() => {})
  const cancel = (): void => { if (pending.current !== null) clearTimeout(pending.current); pending.current = null }
  publish.current = () => {
    setFrame(presentation.frame)
    const next = presentation.nextAt, control = controls.current
    if (next === undefined || !control.active || control.hidden || control.reduce || control.paused || pending.current !== null) return
    pending.current = setTimeout(() => {
      pending.current = null
      if (!controls.current.active || controls.current.hidden || controls.current.paused || controls.current.reduce) return
      presentation.advance(Date.now(), true); publish.current()
    }, Math.max(0, next - Date.now()))
  }
  useLayoutEffect(() => {
    controls.current.active = enabled; controls.current.paused = paused
    if (!enabled) { cancel(); presentation.reset(EMPTY_TOOL_ACTIVITY, Date.now()); setFrame(presentation.frame); return }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (): void => {
      cancel(); controls.current.hidden = document.hidden; controls.current.reduce = media.matches
      if (paused) {
        if (presentation.frame.current === undefined) presentation.reset(latest.current, Date.now())
        presentation.freeze()
      }
      else presentation.reset(latest.current, Date.now())
      publish.current()
    }
    sync(); document.addEventListener('visibilitychange', sync); media.addEventListener('change', sync)
    return () => { controls.current.active = false; cancel(); document.removeEventListener('visibilitychange', sync); media.removeEventListener('change', sync) }
  }, [enabled, paused])
  useLayoutEffect(() => {
    if (!enabled) return
    if (input.blocked || input.items.length === 0) { cancel(); presentation.reset(EMPTY_TOOL_ACTIVITY, Date.now()) }
    else if (controls.current.paused) return
    else if (controls.current.hidden || controls.current.reduce) presentation.reset(input, Date.now())
    else presentation.update(input, Date.now(), true)
    if (presentation.nextAt === undefined) cancel()
    publish.current()
  }, [input, enabled])
  // Block/stop/wait/expansion cannot paint an outgoing stale face for one frame.
  return !enabled || input.blocked || input.items.length === 0 ? { current: undefined, previous: undefined, revision: frame.revision, at: frame.at } : frame
}
