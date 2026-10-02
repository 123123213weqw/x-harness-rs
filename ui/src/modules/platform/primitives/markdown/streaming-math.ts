/** Latest shipped streaming grammar: render completed display math immediately,
 * but keep an unfinished delimiter verbatim until its closing marker arrives. */
import type { BlockContent, DefinitionContent, Paragraph, Root, RootContent } from 'mdast'
import type { Math } from 'mdast-util-math'
import { parseGfmWithMath } from './parse'

function escapedAt(text: string, offset: number): boolean {
  let slashes = 0
  while (offset > 0 && text[offset - 1] === '\\') { slashes++; offset-- }
  return slashes % 2 !== 0
}

function closedDisplayMath(raw: string): boolean {
  const trimmed = raw.trimEnd()
  const opening = raw.match(/^\${2,}/)?.[0]
  if (opening !== undefined) {
    const suffix = trimmed.match(/\$+$/)?.[0] ?? ''
    const closingAt = trimmed.length - suffix.length
    return suffix.length >= opening.length && closingAt >= opening.length && !escapedAt(trimmed, closingAt)
  }
  if (raw.startsWith('\\[')) {
    const closingAt = trimmed.length - 2
    return closingAt >= 2 && trimmed.endsWith('\\]') && !escapedAt(trimmed, closingAt)
  }
  return false
}

function unfinishedMath(node: Math, text: string): Paragraph | undefined {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return undefined
  const raw = text.slice(start, end)
  if (closedDisplayMath(raw)) return undefined
  return {type: 'paragraph', position: node.position, children: [{type: 'text', value: raw}]}
}

export function parseStreamingMath(text: string): Root {
  const root = parseGfmWithMath(text)
  function rewrite(node: BlockContent | DefinitionContent): BlockContent | DefinitionContent
  function rewrite(node: RootContent): RootContent
  function rewrite(node: RootContent): RootContent {
    if (node.type === 'math') return unfinishedMath(node, text) ?? node
    switch (node.type) {
      case 'blockquote':
      case 'listItem':
      case 'footnoteDefinition':
        node.children = node.children.map(child => rewrite(child))
        break
      case 'list':
        node.children.forEach(rewrite)
        break
    }
    return node
  }
  root.children = root.children.map(rewrite)
  return root
}
