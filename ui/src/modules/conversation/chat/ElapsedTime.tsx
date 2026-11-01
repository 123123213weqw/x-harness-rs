import { useEffect, useState } from 'react'

/** Compact whole-second duration; visible units deliberately stay h/m/s. */
export function formatElapsedTime(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

/** Only this leaf ticks. The turn/start anchor survives streaming and reloads;
 *  a missing boundary falls back to mount time, not fabricated Host telemetry. */
export function ElapsedTime({ startTime, endTime, className }: {
  startTime: number | null
  endTime?: number | undefined
  className?: string | undefined
}) {
  const [mountedAt] = useState(() => Date.now())
  const anchor = startTime ?? mountedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (endTime !== undefined) return
    const tick = (): void => setNow(Date.now())
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor, endTime])
  const elapsed = Math.max(0, (endTime ?? now) - anchor)
  return <span className={className} role="timer" aria-live="off" data-elapsed-ms={Math.floor(elapsed)}>
    <time dateTime={`PT${Math.floor(elapsed / 1000)}S`}>{formatElapsedTime(elapsed)}</time>
  </span>
}
