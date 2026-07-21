/** Open JSON/event boundaries stay unknown until their consumed shape is checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
export function isUnknownArray(value: unknown): value is unknown[] { return Array.isArray(value) }
export function isUnknownMap(value: unknown): value is Map<unknown, unknown> { return value instanceof Map }
export function isUnknownSet(value: unknown): value is Set<unknown> { return value instanceof Set }
