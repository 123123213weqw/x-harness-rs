/** The layout owns visibility; header controls request transitions, never infer it from tabs. */
export const workspaceDockEvents = {
  toggle: 'xharness:workspace-toggle',
  visibility: 'xharness:workspace-visibility',
  requestVisibility: 'xharness:workspace-visibility-request',
} as const

export function workspaceDockVisibility(event: Event): boolean | undefined {
  if (!(event instanceof CustomEvent)) return undefined
  const detail: unknown = event.detail
  if (detail === null || typeof detail !== 'object' || !('open' in detail)) return undefined
  return typeof detail.open === 'boolean' ? detail.open : undefined
}
