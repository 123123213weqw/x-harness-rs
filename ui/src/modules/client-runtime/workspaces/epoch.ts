/** Production Host emits epoch milliseconds as decimal strings; upstream
 * fixtures use ISO dates. Preserve both timestamp shapes for recency. */
export function workspaceEpochMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN
  if (typeof value !== 'string') return Number.NaN
  const text = value.trim()
  if (text === '') return Number.NaN
  if (/^-?\d+$/.test(text)) {
    const numeric = Number(text)
    return Number.isSafeInteger(numeric) ? numeric : Number.NaN
  }
  return Date.parse(text)
}
