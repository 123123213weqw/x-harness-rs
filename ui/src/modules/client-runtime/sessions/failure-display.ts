/**
 * Convert a durable failure into copy that is safe to expose in the GUI.
 * @param failure - Failure value preserved by the session event.
 * @returns Display-safe copy for client projections.
 */
export function displayFailureMessage(failure: unknown): string {
  if (failure === null || typeof failure !== 'object') return String(failure)
  const code = 'code' in failure ? failure.code : undefined
  const message = 'message' in failure ? failure.message : undefined
  // Provider AUTH messages may echo a masked or partially preserved credential.
  // Keep the raw diagnostic in the session log, but never project it into UI state.
  if (code === 'AUTH') return 'API key is invalid'
  return typeof message === 'string' ? message : JSON.stringify(failure)
}
