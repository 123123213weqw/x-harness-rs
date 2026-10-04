import { isChatData, isChatNode } from '../contract/chat-node-codec'
import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { JsonBlock } from '../primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots'
import type { ChatNode } from '../contract/chat-nodes'
import css from './ChatView.styles'
import { TranscriptWindowRow } from './TranscriptWindowRow'
import { turnProcessPresentation } from './turn-process'
import { TurnProcessSummary, AdaptiveToolSummary } from './TurnTailNodeView'
import { toolCanAutoFold, type FoldedTools } from './adaptive-tool-fold'
import type { TranscriptValues } from './transcript-state'
import { useProcessMode } from './process-mode'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly keepMounted?: boolean
  readonly useSession: ChatViewSlotProps['useSession']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
  readonly foldedTools?: FoldedTools
  readonly invalidateFoldedTool?: (key: string) => void
  readonly expandedTurns?: ReadonlySet<number>
  readonly toggleTurnProcess?: (turn: number) => void
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

/** Resident, independently subscribed entry before the first loaded work row. */
export function TurnProcessSummarySeat({ nodeKey, useSession, expandedTurns, foldedTools, toggleTurnProcess, t }: Pick<
  ChatNodeSeatProps, 'nodeKey' | 'useSession' | 'expandedTurns' | 'foldedTools' | 'toggleTurnProcess' | 't'
>) {
  const node = useSession(snapshot => snapshot.chat.nodes.get(nodeKey))
  const location = node?.location
  const turnId = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
  const currentTurn = useSession(snapshot => turnId === undefined ? undefined : snapshot.chat.timeline.turns.get(turnId))
  const rawTail = useSession(snapshot => turnId === undefined ? undefined : snapshot.chat.timeline.turns.get(turnId)?.data.get('turn-tail'))
  const tail = useMemo(() => isChatData('turn-tail', rawTail) && rawTail.turn === turnId ? rawTail : undefined, [rawTail, turnId])
  const foldedCount = useSession(snapshot => {
    let count = 0
    for (const key of foldedTools?.get(turnId ?? -1) ?? []) {
      const tool = snapshot.chat.nodes.get(key)
      if (isChatNode(tool) && toolCanAutoFold(tool)) count++
    }
    return count
  })
  if (currentTurn === undefined || toggleTurnProcess === undefined) return null
  if (tail === undefined && (currentTurn.status !== 'open' || foldedCount === 0)) return null
  return <TranscriptWindowRow estimatedHeight={32} className={css.flowItem} data-chat-anchor-key={`turn-process:${currentTurn.turn}`}>
    {tail === undefined ? <AdaptiveToolSummary turn={currentTurn.turn} count={foldedCount} t={t}
      expanded={expandedTurns?.has(currentTurn.turn) ?? false} onToggle={() => { toggleTurnProcess(currentTurn.turn) }} />
      : <TurnProcessSummary turn={currentTurn} data={tail} t={t}
        collapsed={!(expandedTurns?.has(currentTurn.turn) ?? false)} onToggle={() => { toggleTurnProcess(currentTurn.turn) }} />}
  </TranscriptWindowRow>
}

/** Subscribe and dispatch one stable Context key without observing sibling Nodes. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, editMessage, forkMessage, editAvailable, keepMounted,
  renderMessageImages, fileMentions, useSession, renderSlot, t, expandedTurns, foldedTools, invalidateFoldedTool,
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
  const processMode = useProcessMode()
  const previousMode = useRef(processMode)
  // Lightweight seats remain resident even when their heavy child is folded.
  // Reset defaults on an explicit mode switch, including currently unmounted
  // cards; otherwise expanded -> auto -> expanded can revive a stale choice.
  if (previousMode.current !== processMode) {
    presentationState.current.clear()
    previousMode.current = processMode
  }
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
  const autoFoldable = routedNode !== undefined && toolCanAutoFold(routedNode)
  useLayoutEffect(() => {
    if (!autoFoldable) invalidateFoldedTool?.(nodeKey)
  }, [autoFoldable, invalidateFoldedTool, nodeKey])
  const liveTurn = (location?.kind === 'turn' || location?.kind === 'step') && location.turn.status === 'open' && tail === undefined
  const autoHidden = liveTurn && autoFoldable && foldedTools?.get(turn ?? -1)?.has(nodeKey)
    && !(expandedTurns?.has(turn ?? -1) ?? false)
  if (node === undefined || owner === null || presentation.hidden || autoHidden) return null
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
      data-chat-auto-fold-turn={node.kind === 'tool-call' &&
        (location?.kind === 'turn' || location?.kind === 'step') && location.turn.status === 'open' && tail === undefined ? turn : undefined}
      data-chat-auto-fold-eligible={autoFoldable ? 'true' : 'false'}
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
