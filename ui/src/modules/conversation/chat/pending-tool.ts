import type { ChatConversationViewNode, ToolCallBlock } from '../types/runtime'
import { isChatNode } from '../contract/chat-node-codec'

/** Pending root and recursive Computer privacy effects survive offscreen settlement. */
export function transcriptHasPendingTool(node: ChatConversationViewNode | undefined): boolean {
  if (!isChatNode(node) || node.kind !== 'tool-call') return false
  const stack: ToolCallBlock[] = [node.data.root]
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    if (!('kind' in block)) return true
    for (const child of block.subCalls) stack.push(child)
  }
  return false
}
