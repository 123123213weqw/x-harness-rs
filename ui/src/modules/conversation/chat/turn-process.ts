import type { ChatNode, TurnTailChatData } from '../contract/chat-nodes'
import { toolCanAutoFold } from './adaptive-tool-fold'

/** Only an authoritative turn/end tail closes the process; idle/step/end do not. */
export function turnProcessPresentation(node: ChatNode, tail: Readonly<TurnTailChatData> | undefined, expanded: boolean): {
  collapsed: boolean
  hidden: boolean
} {
  const collapsed = tail !== undefined && !expanded
  if (!collapsed) return { collapsed: false, hidden: false }
  switch (node.kind) {
    case 'assistant-step':
      return { collapsed, hidden: tail.closing === null || node.data.finalNode?.seq !== tail.closing.finalNode.seq }
    case 'tool-call':
      // A stale turn/end must never suppress a recursive pending Tool or a
      // reported failure. Composer approvals/questions have their own seats.
      if (node.data.root !== undefined && !toolCanAutoFold(node)) return { collapsed, hidden: false }
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
