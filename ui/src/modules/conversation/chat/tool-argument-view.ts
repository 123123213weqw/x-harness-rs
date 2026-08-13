/** Presentation only: never parse a partial input into an executable tool call. */
export const TOOL_ARGUMENT_PREVIEW_LIMIT = 16_384
export function boundedToolArgumentText(raw: string): { text: string; truncated: boolean } {
  let text = raw.slice(0, TOOL_ARGUMENT_PREVIEW_LIMIT)
  // A network chunk or preview boundary may end halfway through an emoji.
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  return { text, truncated: raw.length > TOOL_ARGUMENT_PREVIEW_LIMIT }
}
const textFields = new Set(['command', 'cmd', 'content', 'file_text', 'patch', 'patchText', 'new_string', 'newString', 'code'])

function readString(raw: string, start: number, limit: number): { text: string; end: number; complete: boolean; truncated: boolean } {
  let text = '', truncated = false
  const append = (value: string) => {
    if (text.length + value.length <= limit) text += value
    else truncated = true
  }
  let i = start + 1
  while (i < raw.length) {
    const c = raw[i++]
    if (c === undefined) break
    if (c === '"') return { text, end: i, complete: true, truncated }
    if (c !== '\\') { append(c); continue }
    const escape = raw[i++]
    if (escape === undefined) break
    if (escape === 'u') {
      const hex = raw.slice(i, i + 4)
      if (!/^[\da-f]{4}$/i.test(hex)) break
      append(String.fromCharCode(Number.parseInt(hex, 16))); i += 4
    } else {
      const escaped: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }
      const decoded = escaped[escape]
      if (decoded === undefined) break
      append(decoded)
    }
  }
  return { text, end: i, complete: false, truncated }
}

/** Decode a top-level text field for readability; the raw input remains authoritative. */
export function toolArgumentPreview(raw: string): { text: string; field: string | null; truncated: boolean } {
  let depth = 0
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === '"') {
      const key = readString(raw, i, 256)
      let cursor = key.end
      while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length) cursor++
      if (depth === 1 && key.complete && !key.truncated && textFields.has(key.text) && raw[cursor] === ':') {
        cursor++
        while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length) cursor++
        if (raw[cursor] === '"') {
          const value = readString(raw, cursor, TOOL_ARGUMENT_PREVIEW_LIMIT)
          return { text: boundedToolArgumentText(value.text).text, field: key.text, truncated: value.truncated }
        }
      }
      i = Math.max(i, key.end - 1)
    }
  }
  return { ...boundedToolArgumentText(raw), field: null }
}

export function formatToolArgumentBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`
}
