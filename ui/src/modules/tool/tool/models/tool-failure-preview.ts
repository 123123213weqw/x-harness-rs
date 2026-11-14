/** The disclosure retains full output; its one-line preview must not be a raw
 * JSON envelope or an unbounded transcript. Parsing is strictly size-bounded. */
export function toolFailurePreview(output: string, fallback = 'Tool execution failed'): string {
  const line = (value: string): string => {
    let text = '', count = 0
    for (const character of value.trim()) {
      if (character === '\n' || count++ >= 240) break
      text += character
    }
    return text.trimEnd()
  }
  const raw = output.trim()
  if (!raw.startsWith('{') && !raw.startsWith('[')) return line(raw) || fallback
  if (raw.length > 16_384) return fallback
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return fallback
    for (const key of ['message', 'error']) {
      if (!(key in value)) continue
      const field: unknown = Reflect.get(value, key)
      if (typeof field === 'string' && field.trim() !== '' && !/^[\[{]/.test(field.trim())) return line(field)
      if (typeof field === 'object' && field !== null && 'message' in field && typeof field.message === 'string' && field.message.trim() !== '') return line(field.message)
    }
  } catch { /* A malformed error still has its verbatim expanded output. */ }
  return fallback
}
