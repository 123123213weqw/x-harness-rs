import type { ChatNode, TurnTailChatData } from '../contract/chat-nodes'
import { toolCanFoldAfterTurn } from './adaptive-tool-fold'
import { preparingCall } from './preparing-call'

/** Only an authoritative turn/end tail closes the process; idle/step/end do not. */
export function turnProcessPresentation(node: ChatNode, tail: Readonly<TurnTailChatData> | undefined, expanded: boolean, live = false): {
  collapsed: boolean
  hidden: boolean
} {
  const collapsed = (tail !== undefined || live) && !expanded
  if (!collapsed) return { collapsed: false, hidden: false }
  if (tail === undefined) {
    // Active/failed tools remain under the protected adaptive-fold policy.
    // Reasoning-only rows have one turn summary instead of growing blank seats.
    const hidden = node.kind === 'assistant-step' && node.data.status !== 'interrupted'
      && !node.data.blocks.some(block => block.kind !== 'reasoning' && block.kind !== 'tool-call'
        && (block.kind !== 'text' || block.text.trim() !== ''))
      && !node.data.blocks.some(preparingCall)
    return { collapsed, hidden }
  }
  switch (node.kind) {
    case 'assistant-step':
      return { collapsed, hidden: tail.closing === null || node.data.finalNode?.seq !== tail.closing.finalNode.seq }
    case 'tool-call':
      // Keep failures and recursive pending/unknown outcomes visible even
      // if a stale turn/end is present; completion is not success.
      // Composer approvals/questions and turn failures have their own seats.
      if (node.data.root !== undefined && !toolCanFoldAfterTurn(node)) return { collapsed, hidden: false }
      return { collapsed, hidden: true }
    case 'model-retry':
    case 'context':
    case 'compaction':
      return { collapsed, hidden: true }
    // Never suppress user instructions, terminal notices or unknown extensions.
    default:
      return { collapsed, hidden: false }
  }
}
