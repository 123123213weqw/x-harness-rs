/** Navigation only: never accepts a Host URL, session id, credentials or prompt. */
export const NEW_TASK_FRAGMENT = '#new-task'

/** Consume once before connecting, keeping existing history and drafts intact. */
export function consumeNewTaskIntent(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState' | 'state'>,
  clearSelection: () => void,
): boolean {
  if (location.hash !== NEW_TASK_FRAGMENT) return false
  // If the browser refuses navigation, do not acknowledge a new-task landing.
  history.replaceState(history.state, '', location.pathname + location.search)
  clearSelection()
  return true
}
