/** A display projection, never an instruction to re-run a page's action. */
export const SHELL_ROUTE_CHANGED = 'xharness:shell-route-changed'

export function observeShellPage(page: string, setActive: (active: boolean) => void): () => void {
  const changed = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return
    const detail: unknown = event.detail
    if (typeof detail === 'object' && detail !== null && 'page' in detail && typeof detail.page === 'string') {
      setActive(detail.page === page)
    }
  }
  window.addEventListener(SHELL_ROUTE_CHANGED, changed)
  return () => window.removeEventListener(SHELL_ROUTE_CHANGED, changed)
}
