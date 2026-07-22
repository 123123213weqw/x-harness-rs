/** Current product parser: Host decimal milliseconds and later ISO timestamps share one ordering/display boundary. */
export function xhEpochMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value !== 'string') return NaN
  const text = value.trim()
  if (text === '') return NaN
  if (/^-?\d+$/.test(text)) {
    const numeric = Number(text)
    return Number.isSafeInteger(numeric) ? numeric : NaN
  }
  return Date.parse(text)
}
