import { useEffect, useState } from 'react'

/** Display-only preference, shared with Tool and Experience; never mutates the session. */
export function useProcessMode(): string {
  const read = (): string => typeof document === 'undefined' ? 'standard' : document.documentElement.dataset.xhProcessMode || 'standard'
  const [mode, setMode] = useState(read)
  useEffect(() => {
    const update = (): void => { setMode(read()) }
    window.addEventListener('xh-process-mode', update)
    update()
    return () => { window.removeEventListener('xh-process-mode', update) }
  }, [])
  return mode
}
