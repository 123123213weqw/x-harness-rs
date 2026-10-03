import { memo } from 'react'
import type { PropsRenderSlots } from "../types/slots"
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots'
import { MessageIconActions } from './MessageIconActions'
import { assistantText } from './turn-assistant'
import css from './TurnTailNodeView.styles'
import { IconChevronRightOutline14 } from '../primitives'
import { formatRunDuration } from './message-chrome'
import type { TurnLocation } from '../types/runtime'
import type { TurnTailChatData } from '../contract/chat-nodes'

/** Visible independently of hover, final prose, or contributed tail slots. */
export function TurnProcessSummary({ turn, data, t, collapsed, onToggle }: {
  turn: TurnLocation
  data: Readonly<TurnTailChatData>
  t: ChatNodeViewProps['t']
  collapsed: boolean
  onToggle: () => void
}) {
  const runMs = turn.start === undefined || turn.end === undefined ? undefined : Math.max(0, turn.end.time - turn.start.time)
  const label = runMs === undefined ? t('message.turnFinished') : t('message.ranFor', { duration: formatRunDuration(runMs, t) })
  return <button type="button" className={css.summary} data-turn-process-summary={data.turn}
    aria-expanded={!collapsed} aria-label={`${label} · ${t(collapsed ? 'message.expandProcess' : 'message.collapseProcess')}`}
    onClick={onToggle}><span>{label}</span><IconChevronRightOutline14 /></button>
}

type TurnTailNodeViewProps = ChatNodeViewProps<'turn-tail'>
  & PropsRenderSlots<'conversation.chat.turnTail' | 'conversation.chat.assistant-actions'>

/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node, openFile, forkAt, renderSlot, renderSlotChain, t, useSession,
}: TurnTailNodeViewProps) {
  const data = node.data
  const hasLaterChatNode = useSession(snapshot =>
    snapshot.chat.locations.getTurn(data.turn).at(-1) !== node.key)
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn === undefined) return null
  const closing = data.closing
  const owner: TurnTailOwnerProps = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile }
  const tail = renderSlotChain('conversation.chat.turnTail', owner)
  if (closing === null) return tail === null ? null : <div className={css.root}>{tail}</div>
  // Interruption-frozen partials carry no messageId, so they address no
  // durable message and contribute no per-message actions.
  const messageId = closing.finalNode.messageId
  const assistantActions = messageId === undefined
    ? null
    : renderSlot('conversation.chat.assistant-actions', { messageId })
  return (
    <div className={css.root} data-turn-tail={data.turn} data-time-hover-root>
      {tail}
      <MessageIconActions
        text={assistantText(closing.blocks)}
        time={closing.time}
        ttftMs={data.ttftMs}
        tokensPerSecond={data.tokensPerSecond}
        clock="end"
        onBranch={() => { forkAt(closing.finalNode.seq) }}
        branchUnavailable={data.branchUnavailable || hasLaterChatNode}
        className={css.actions}
        extraActions={assistantActions}
        t={t}
      />
    </div>
  )
})
