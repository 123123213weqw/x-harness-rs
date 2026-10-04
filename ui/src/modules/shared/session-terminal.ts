import { TurnEndDataInputSchema, SESSION_TERMINAL_CONTRACT } from './generated/session-terminal'

/** Validate the owned terminal boundary before any Session/timeline mutation.
 * Keep the immutable carrier and foreign extension fields; do not normalize,
 * synthesize success, or copy raw payloads into diagnostics.
 */
export function validateSessionTerminal(event: { readonly type: string; readonly seq: number; readonly data: unknown }): void {
  if (event.type !== 'turn/end') return
  const decoded = TurnEndDataInputSchema.safeParse(event.data)
  if (!decoded.success) {
    const issues = decoded.error.issues.slice(0, 4).map(issue => issue.path.join('.') + ':' + issue.code).join(', ')
    throw new Error(`${SESSION_TERMINAL_CONTRACT}: invalid turn/end at seq ${event.seq} (${issues})`)
  }
}
