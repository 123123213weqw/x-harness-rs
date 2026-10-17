import { isObjectRecord } from '../../shared/runtime-types'

const PREVIEW_LENGTH = 80
const WHITESPACE = /\s/

export interface MessageMarker { readonly key: string; readonly preview: string }

/** Keep navigation chrome independent of unrelated assistant/tool deltas.
 * Content arrays are immutable publications; weak keys never pin old histories.
 * Only the current bounded previews and ordered marker list remain resident.
 */
export class MessageMarkerCache {
  private markers: readonly MessageMarker[] = []
  private readonly previews = new WeakMap<readonly unknown[], string>()

  read(order: readonly string[], contentOf: (key: string) => readonly unknown[] | undefined): readonly MessageMarker[] {
    let changed: MessageMarker[] | undefined
    let index = 0
    for (const key of order) {
      const content = contentOf(key)
      if (content === undefined) continue
      let preview = this.previews.get(content)
      if (preview === undefined) {
        preview = messagePreview(content)
        this.previews.set(content, preview)
      }
      const old = this.markers[index]
      const marker = old?.key === key && old.preview === preview ? old : { key, preview }
      if (changed === undefined && marker !== old) changed = this.markers.slice(0, index)
      changed?.push(marker)
      index++
    }
    if (changed !== undefined) this.markers = changed
    else if (index !== this.markers.length) this.markers = this.markers.slice(0, index)
    return this.markers
  }
}

/** Navigation-only text, equivalent to joining text blocks with a space,
 * collapsing whitespace, trimming, then slicing the first 80 UTF-16 units.
 * Build a small independent string instead of normalizing the entire message
 * and retaining its backing storage through a short substring. */
export function messagePreview(content: readonly unknown[]): string {
  const chars: string[] = []
  let pendingSpace = false
  for (const block of content) {
    if (!isObjectRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    // A join separator is whitespace even when this text block is empty.
    if (chars.length > 0) pendingSpace = true
    const text = block.text
    for (let index = 0; index < text.length; index++) {
      const char = text.charAt(index)
      if (WHITESPACE.test(char)) {
        if (chars.length > 0) pendingSpace = true
        continue
      }
      // Delay whitespace until another visible unit: trailing whitespace must
      // be trimmed before slicing, but a separator at unit 80 is preserved.
      if (pendingSpace) {
        chars.push(' ')
        pendingSpace = false
        if (chars.length === PREVIEW_LENGTH) return chars.join('')
      }
      chars.push(char)
      if (chars.length === PREVIEW_LENGTH) return chars.join('')
    }
  }
  return chars.join('')
}
