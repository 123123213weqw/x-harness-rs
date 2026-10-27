import { isRecord } from '../value-guards'
import type { SessionWireEvent } from '../../client-connection/contracts/host/apiproxy/api/sessions'

/** UI-only residency policy. Durable history and model context are untouched. */
export const ACTIVE_WINDOW = Object.freeze({
  highEvents: 4096, lowEvents: 2048,
  highBytes: 8 * 1024 * 1024, lowBytes: 4 * 1024 * 1024,
})

/** Conservative retained-payload weight, computed once per accepted entry. */
export function payloadWeight(value: unknown): number {
  let bytes = 0
  const stack: unknown[] = [value], seen = new WeakSet<object>()
  while (stack.length && bytes <= ACTIVE_WINDOW.highBytes) {
    const item = stack.pop()
    if (typeof item === 'string') bytes += 24 + item.length * 2
    else if (isRecord(item)) {
      if (seen.has(item)) continue
      seen.add(item)
      bytes += 64
      for (const key of Object.keys(item)) {
        bytes += 16 + key.length * 2
        stack.push(item[key])
      }
    } else bytes += 8
  }
  return bytes
}

/** Drop only complete prefixes at a recorded turn start; never cut a live turn.
 * A giant current turn or an explicit reader pin is intentionally a soft limit. */
export function activeWindowCut(events: readonly SessionWireEvent[], weights: readonly number[], bytes: number): number {
  if (events.length <= ACTIVE_WINDOW.highEvents && bytes <= ACTIVE_WINDOW.highBytes) return 0
  let removed = 0, cut = 0, closedAt = 0
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (index > 0 && event?.type === 'turn/start' && closedAt > 0) {
      cut = closedAt
      if (events.length - index <= ACTIVE_WINDOW.lowEvents && bytes - removed <= ACTIVE_WINDOW.lowBytes) return cut
    }
    if (event?.type === 'turn/start') closedAt = 0
    if (event?.type === 'turn/end') closedAt = index + 1
    removed += weights[index] ?? 0
  }
  return cut
}
