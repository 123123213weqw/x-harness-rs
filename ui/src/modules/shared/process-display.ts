import { useEffect, useState } from 'react'

/** One display policy for settings, turns, tools and reasoning. No Host/RPC state. */
export type ProcessMode = 'auto' | 'expanded'
export const PROCESS_MODE_KEY = 'xharness.ui.process-mode.v1'
export function normalizeProcessMode(value: unknown): ProcessMode {
  // Keep the old preference key: no data migration or destructive storage reset.
  return value === 'expanded' || value === 'verbose' ? 'expanded' : 'auto'
}
export function useProcessMode(): ProcessMode {
  const read = (): ProcessMode => normalizeProcessMode(typeof document === 'undefined' ? undefined : document.documentElement.dataset.xhProcessMode)
  const [mode, setMode] = useState(read)
  useEffect(() => {
    const update = (): void => { setMode(read()) }
    window.addEventListener('xh-process-mode', update)
    update()
    return () => { window.removeEventListener('xh-process-mode', update) }
  }, [])
  return mode
}
