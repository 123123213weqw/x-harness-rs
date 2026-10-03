import { isChatData, isChatNode } from '../contract/chat-node-codec'
import { memo, useMemo, useRef } from 'react'
import { JsonBlock } from '../primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots'
import type { ChatNode } from '../contract/chat-nodes'
import css from './ChatView.styles'
import { TranscriptWindowRow } from './TranscriptWindowRow'
import { turnProcessPresentation } from './turn-process'
import { TurnProcessSummary } from './TurnTailNodeView'
import type { TranscriptValues } from './transcript-state'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly keepMounted?: boolean
  readonly useSession: ChatViewSlotProps['useSession']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
  readonly expandedTurns?: ReadonlySet<number>
  readonly toggleTurnProcess?: (turn: number) => void
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

/** Resident, independently subscribed entry before the first loaded work row. */
export function TurnProcessSummarySeat({ nodeKey, useSession, expandedTurns, toggleTurnProcess, t }: Pick<
  ChatNodeSeatProps, 'nodeKey' | 'useSession' | 'expandedTurns' | 'toggleTurnProcess' | 't'
>) {
  const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey))
  const location = node?.location
  const turnId = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
  const currentTurn = useSession(snapshot => turnId === undefined ? undefined : snapshot.chat.timeline.turns.get(turnId))
  const rawTail = useSession(snapshot => turnId === undefined ? undefined : snapshot.chat.timeline.turns.get(turnId)?.data.get('turn-tail'))
  const tail = useMemo(() => isChatData('turn-tail', rawTail) && rawTail.turn === turnId ? rawTail : undefined, [rawTail, turnId])
  if (currentTurn === undefined || tail === undefined || toggleTurnProcess === undefined) return null
  return <TranscriptWindowRow estimatedHeight={32} className={css.flowItem} data-chat-anchor-key={`turn-process:${currentTurn.turn}`}>
    <TurnProcessSummary turn={currentTurn} data={tail} t={t}
      collapsed={!(expandedTurns?.has(currentTurn.turn) ?? false)} onToggle={() => { toggleTurnProcess(currentTurn.turn) }} />
  </TranscriptWindowRow>
}

/** Subscribe and dispatch one stable Context key without observing sibling Nodes. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, editMessage, forkMessage, editAvailable, keepMounted,
  renderMessageImages, fileMentions, useSession, renderSlot, t, expandedTurns,
}: ChatNodeSeatProps) {
  const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey))
  const routedNode = isChatNode(node) ? node : undefined
  const location = node?.location
  const turn = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
  const rawTail = useSession(snapshot => turn === undefined ? undefined : snapshot.chat.timeline.turns.get(turn)?.data.get('turn-tail'))
  const tail = useMemo(() => isChatData('turn-tail', rawTail) && rawTail.turn === turn ? rawTail : undefined, [rawTail, turn])
  const presentation = routedNode === undefined ? { collapsed: false, hidden: false }
    : turnProcessPresentation(routedNode, tail, expandedTurns?.has(turn ?? -1) ?? false)
  // This seat, not its heavy/windowed child, owns display choices. Whole-turn
  // folding must not erase Think/Tool/Compaction/native-details expansion.
  const presentationState = useRef<TranscriptValues>(new Map())
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
      processCollapsed: presentation.collapsed,
    }, [
    node, selectedCallId, cwd, openFile, inspectCall, forkAt, editMessage, forkMessage, editAvailable, renderMessageImages, fileMentions, presentation.collapsed,
  ])
  if (node === undefined || owner === null || presentation.hidden) return null
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = routedNode === undefined ? undefined : ownerFor(owner, routedNode)
  return (
    <TranscriptWindowRow
      keepMounted={keepMounted ?? false}
      presentationState={presentationState.current}
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
