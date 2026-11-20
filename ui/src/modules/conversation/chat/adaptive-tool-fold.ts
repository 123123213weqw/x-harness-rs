import type { ChatNode } from '../contract/chat-nodes'
import type { ToolCallBlock } from '../types/runtime'

/** Display budget only: no request, token, Tool output or runtime policy changes. */
export const TOOL_FOLD_VIEWPORT_SHARE = 0.4
export type FoldedTools = ReadonlyMap<number, ReadonlySet<string>>
export const NO_FOLDED_TOOLS: FoldedTools = new Map()

/** Active compaction only summarizes successful, fully returned call trees. */
export function toolCanAutoFold(node: ChatNode): boolean {
  return toolCanFold(node, 'live')
}

/** After turn/end, a known failure is foldable, but a missing/uncertain result
 * or Agent communication remains visible, even in a nested call. */
export function toolCanFoldAfterTurn(node: ChatNode): boolean {
  return toolCanFold(node, 'closed')
}

const LIVE_SUMMARY_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'glob', 'bash', 'pwsh', 'run_code', 'todolist', 'todo_write', 'web_search', 'web_fetch'])

/** Conservative live-only subset: native/plugin privacy and interactive seats
 * must remain mounted. Completed rows retain the existing recursive policy. */
export function toolCanSummarizeLive(node: ChatNode): boolean {
  if (node.kind !== 'tool-call' || node.data.root === undefined) return false
  const stack: ToolCallBlock[] = [node.data.root]
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    if ('kind' in block) {
      if (!toolCanFold({ ...node, data: { root: block } }, 'live')) return false
      continue
    } else if (!LIVE_SUMMARY_TOOLS.has(block.name) || block.callView !== null) return false
    stack.push(...block.subCalls)
  }
  return true
}

function toolCanFold(node: ChatNode, phase: 'live' | 'closed'): boolean {
  if (node.kind !== 'tool-call' || node.data.root === undefined) return false
  const stack: ToolCallBlock[] = [node.data.root]
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    // turn/end closes the turn, not every observed tool. Keep an unresolved
    // call or synthetic interrupted result visible in a partial transcript.
    if (!('kind' in block) || block.kind !== 'tool-result'
      || block.error?.code === 'OUTCOME_UNKNOWN' || block.error?.code === 'interrupted'
      || block.call?.name === 'agent') return false
    if (phase === 'live') {
      if (block.isError) return false
      // Shell cards can report a nonzero exit without isError on the envelope.
      const view = block.resultView
      if (typeof view === 'object' && view !== null && 'card' in view && view.card === 'terminal'
        && (('exitCode' in view && typeof view.exitCode === 'number' && view.exitCode !== 0)
          || ('signal' in view && typeof view.signal === 'string' && view.signal !== ''))) return false
    }
    for (const child of block.subCalls) stack.push(child)
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
