/** Object/array admission does not assign unverified fields a domain type. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}
