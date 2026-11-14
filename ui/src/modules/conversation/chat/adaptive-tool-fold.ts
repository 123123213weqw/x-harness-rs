import type { ChatNode } from '../contract/chat-nodes'
import type { ToolCallBlock } from '../types/runtime'

/** Display budget only: no request, token, Tool output or runtime policy changes. */
export const TOOL_FOLD_VIEWPORT_SHARE = 0.4
export type FoldedTools = ReadonlyMap<number, ReadonlySet<string>>
export const NO_FOLDED_TOOLS: FoldedTools = new Map()

/** Fail open on active, failed, recursive pending, or unknown tool carriers. */
export function toolCanAutoFold(node: ChatNode): boolean {
  return toolCanFold(node)
}

/** Failures remain outside the disclosure even after an authoritative turn/end. */
export function toolCanFoldAfterTurn(node: ChatNode): boolean {
  return toolCanFold(node)
}

function toolCanFold(node: ChatNode): boolean {
  if (node.kind !== 'tool-call') return false
  const stack: ToolCallBlock[] = [node.data.root]
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    // Agent communication acknowledgements must remain visible when a turn
    // closes or its tool activity is folded. This does not pin offscreen DOM:
    // ordinary transcript windowing still applies, including nested calls.
    if (('kind' in block ? block.call?.name : block.name) === 'agent') return false
    // Projection's synthetic interrupted result has no settled tool/result.
    if (!('kind' in block) || block.kind !== 'tool-result'
      || block.error?.code === 'OUTCOME_UNKNOWN' || block.error?.code === 'interrupted'
      || block.isError) return false
    // Shell cards can report a nonzero exit without isError on the envelope.
    const view = block.resultView
    if (typeof view === 'object' && view !== null && 'card' in view && view.card === 'terminal'
      && (('exitCode' in view && typeof view.exitCode === 'number' && view.exitCode !== 0)
        || ('signal' in view && typeof view.signal === 'string' && view.signal !== ''))) return false
    stack.push(...block.subCalls)
  }
  return true
}

export interface ToolFoldRow {
  readonly key: string
  readonly turn: number
  readonly height: number
  readonly eligible: boolean
  readonly protected: boolean
}

/** Oldest successful roots first. Keep the newest root and all protected rows.
 * Sticky folding avoids resize oscillation; explicit expansion bypasses it.
 * Window placeholders contribute their bounded estimate, without mounting them.
 */
export function planToolFold(rows: readonly ToolFoldRow[], viewportHeight: number, share = TOOL_FOLD_VIEWPORT_SHARE, compact = false): ReadonlySet<string> {
  const hidden = new Set<string>()
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0 || !Number.isFinite(share) || share <= 0 || share >= 1) return hidden
  const turns = new Map<number, ToolFoldRow[]>()
  for (const row of rows) {
    const group = turns.get(row.turn) ?? []
    group.push(row); turns.set(row.turn, group)
  }
  const budget = viewportHeight * share
  for (const group of turns.values()) {
    let height = group.reduce((sum, row) => sum + (Number.isFinite(row.height) ? Math.max(0, row.height) : 0), 0)
    for (const row of group.slice(0, -1)) {
      if (!compact && height <= budget) break
      if (!row.eligible || row.protected || !Number.isFinite(row.height) || row.height <= 0) continue
      hidden.add(row.key); height -= row.height
    }
  }
  return hidden
}
