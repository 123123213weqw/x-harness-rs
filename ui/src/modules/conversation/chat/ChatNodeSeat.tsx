import { isChatNode } from '../contract/chat-node-codec'
import { memo, useMemo } from 'react'
import { JsonBlock } from '../primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots'
import type { ChatNode } from '../contract/chat-nodes'
import css from './ChatView.styles'
import { TranscriptWindowRow } from './TranscriptWindowRow'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly keepMounted?: boolean
  readonly useSession: ChatViewSlotProps['useSession']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

/** Subscribe and dispatch one stable Context key without observing sibling Nodes. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, editMessage, forkMessage, editAvailable, keepMounted,
  renderMessageImages, fileMentions, useSession, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey))
  const routedNode = isChatNode(node) ? node : undefined
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      selectedCallId,
      cwd,
      openFile,
      inspectCall,
      forkAt,
      editMessage, forkMessage, editAvailable,
      renderMessageImages,
      fileMentions,
    }, [
    node, selectedCallId, cwd, openFile, inspectCall, forkAt, editMessage, forkMessage, editAvailable, renderMessageImages, fileMentions,
  ])
  if (node === undefined || owner === null) return null
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = routedNode === undefined ? undefined : ownerFor(owner, routedNode)
  return (
    <TranscriptWindowRow
      keepMounted={keepMounted ?? false}
      className={css.flowItem}
      data-chat-anchor-key={node.key}
      data-chat-flow-key={node.key}
      data-chat-flow-kind={node.kind}
    >
      {routedOwner === undefined ? <JsonBlock label={t('message.unknownSurface', { type: node.kind })} payload={node.data} truncatedLabel={(total: number) => t('json.truncated', { total })} /> : renderSlot('conversation.chat.node', routedOwner, {
        entryKey: routedOwner.node.kind,
        hookContext: nodeKey,
        fallback: (
          <JsonBlock
            label={t('message.unknownSurface', { type: node.kind })}
            payload={node.data}
            truncatedLabel={(total: number) => t('json.truncated', { total })}
          />
        ),
      })}
    </TranscriptWindowRow>
  )
})

function ownerFor(owner: ChatNodeOwnerProps, node: ChatNode): RoutedChatNodeOwner {
  switch (node.kind) {
    case 'user': return { ...owner, node }
    case 'steering': return { ...owner, node }
    case 'context': return { ...owner, node }
    case 'command': return { ...owner, node }
    case 'compaction': return { ...owner, node }
    case 'manual-compaction': return { ...owner, node }
    case 'assistant-step': return { ...owner, node }
    case 'tool-call': return { ...owner, node }
    case 'model-retry': return { ...owner, node }
    case 'turn-error': return { ...owner, node }
    case 'turn-max-tokens': return { ...owner, node }
    case 'unknown': return { ...owner, node }
    case 'run-checkpoint': return { ...owner, node }
    case 'turn-tail': return { ...owner, node }
  }
}
