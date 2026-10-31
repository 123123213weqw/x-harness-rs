import { memo } from 'react'
import { ChatNodeSeat, TurnProcessSummarySeat } from './ChatNodeSeat'
import type { ChatNodeSeatProps } from './ChatNodeSeat'

export type ChatFlowProps = Omit<ChatNodeSeatProps, 'nodeKey' | 'keepMounted'> & {
  readonly order: readonly string[]
  readonly processHeads: ReadonlySet<string>
  readonly sessionId: string
  readonly lastKey: string | null
}

/** The structural list is independent of streaming content and shell chrome.
 * Node seats retain their own subscriptions, including pending-tool pinning. */
export const ChatFlow = memo(function ChatFlow({ order, processHeads, sessionId, lastKey, ...owner }: ChatFlowProps) {
  return <>{order.flatMap(nodeKey => [
    ...(processHeads.has(nodeKey) ? [<TurnProcessSummarySeat
      key={`${sessionId}:process:${nodeKey}`} nodeKey={nodeKey} {...owner} />] : []),
    <ChatNodeSeat key={`${sessionId}:node:${nodeKey}`} nodeKey={nodeKey}
      keepMounted={!owner.editAvailable && nodeKey === lastKey} {...owner} />,
  ])}</>
})
