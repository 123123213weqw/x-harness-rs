import { transcriptHasPendingTool } from './pending-tool'
import { useAdaptiveToolFold } from './use-adaptive-tool-fold'
import { useProcessMode } from './process-mode'
// ChatView: the default conversation view — one stable keyed parent list over
// final business Nodes, plus paging, pending steering and bottom-follow.
// Each row dispatches through 'conversation.chat.node'; ui-tool owns the
// tool-call renderer and its recursive root/subcall composition. A Host
// open-path refusal from the injected opener is an in-page dialog here.
//
// Scroll: when nested under `[data-conversation-scroll]` (active conversation
// column), that host is the scrollport and this view is flow content; when
// mounted alone (unit tests), `.scroll` owns overflow. Bottom-follow and
// prepend anchoring always target the resolved scrollport.
//
// Render economics: order changes only when rows enter, leave or move. Each
// ChatNodeSeat subscribes to one Node key, so Assistant deltas and Tool
// lifecycle updates replace only their own row without remounting it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationTimelineSnapshot } from "../types/runtime"
import { Button, IconChevronDownOutline14, Modal, Tooltip } from '../primitives'
import type { ChatViewSlotProps, RenderMessageImages } from '../contract/slots'
import { PendingSteeringBubble } from './MessageItem'
import { ChatNodeSeat, TurnProcessSummarySeat } from './ChatNodeSeat'
import { bindTranscriptFollow } from './TranscriptWindowRow'
import { formatRunDuration } from './message-chrome'
import { isObjectRecord } from '../../shared/runtime-types'
import { isChatNode } from '../contract/chat-node-codec'
import css from './ChatView.styles'
import railCss from './MessageRail.styles'

const FOLLOW_THRESHOLD = 24

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

interface PagingAnchor {
  /** Stable node/call identity, independent of boundary-spanning group keys. */
  key: string
  /** Row top relative to the scrollport after the latest user scroll. */
  top: number
}

/** Find an already-rendered settled row without interpolating a selector. */
function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list: HTMLElement, scrollport: HTMLElement): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect()
  const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
  const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
  // Scroll events are hot: hit-test a few points through the stretched flow
  // rows before considering the full mounted set. The fallback keeps jsdom
  // and pre-layout states deterministic; a virtualizer naturally bounds it.
  if (typeof document.elementsFromPoint === 'function' && visibleBottom > viewport.top) {
    const content = list.getBoundingClientRect()
    const left = Math.max(viewport.left, content.left)
    const right = Math.min(viewport.right, content.right)
    const x = left + Math.max(0, right - left) / 2
    const height = visibleBottom - viewport.top
    const points = [1, Math.min(32, height / 3), height / 2, Math.max(1, height - 1)]
    for (const offset of points) {
      for (const element of document.elementsFromPoint(x, viewport.top + offset)) {
        const row = element instanceof HTMLElement
          ? element.closest<HTMLElement>('[data-chat-anchor-key]')
          : null
        if (row !== null && list.contains(row)) return row
      }
    }
  }
  const rows = [...list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
  const visibleRows = rows.filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > viewport.top && rect.top < visibleBottom
  })
  return visibleRows[0] ?? rows[0] ?? null
}

type ChatScrollPosition = NonNullable<ReturnType<ChatViewSlotProps['chatScroll']['read']>>

/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list: HTMLElement, scrollport: HTMLElement): ChatScrollPosition | null {
  const row = pagingAnchor(list, scrollport)
  const anchorKey = row?.dataset.chatAnchorKey
  if (row === null || anchorKey === undefined) return null
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  }
}

/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/** ProducedFiles opens the session workspace as `.`. */
function isFolderOpenPath(path: string): boolean {
  return path === '.'
}

function runningTurnStartTime(timeline: ConversationTimelineSnapshot): number | null {
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open' && turn.start !== undefined) latest = turn.start.time
  }
  return latest
}

/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
function TurnStatus({ startTime, t }: {
  /** The running turn's logged `turn/start` time; null falls back to mount
   *  time when that boundary is outside the window. */
  startTime: number | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={css.turnStatus} role="status" aria-live="polite">
      {t('xh.turn.working')}
      {showClock && (
        <span className={css.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      )}
    </div>
  )
}

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt,
  fileMentions, editMessage, forkMessage, t,
}: ChatViewSlotProps) {
  const order = useSession(s => s.chat.order)
  const nodeStore = useSession(s => s.chat.nodes)
  const timeline = useSession(s => s.chat.timeline)
  const inbox = useSession(s => s.queue)
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const selectedCallId = useStore(s => s.selection?.callId)
  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  const processMode = useProcessMode()
  const [processState, setProcessState] = useState<{ sessionId: string; mode: string; choices: ReadonlyMap<number, boolean> }>(
    () => ({ sessionId, mode: processMode, choices: new Map() }),
  )
  // A global mode change deliberately reapplies defaults. Manual group choices
  // win until then, stay turn/session-local and do not disable windowing.
  if (processState.sessionId !== sessionId || processState.mode !== processMode) {
    setProcessState({ sessionId, mode: processMode, choices: new Map() })
  }
  const expandedTurns = useMemo(() => {
    const result = new Set<number>()
    const choices = processState.sessionId === sessionId && processState.mode === processMode ? processState.choices : undefined
    for (const turn of timeline.turns.keys()) {
      if (choices?.get(turn) ?? processMode === 'expanded') result.add(turn)
    }
    return result
  }, [timeline, processState, sessionId, processMode])
  // Close/retry must ignore a settlement that started before the latest
  // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
  const fileOpenRequest = useRef(0)

  const requestOpenFile = useCallback((path: string) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    void openFile(path).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t(isFolderOpenPath(path) ? 'fileOpen.folderUnknown' : 'fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [openFile, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
    setFileOpenBusy(false)
  }, [])

  const pendingSteering = useMemo(
    () => inbox.filter(item => item.placement === 'steering'),
    [inbox],
  )
  const messageMarkers = useMemo(() => order.flatMap(key => {
    const node = nodeStore.get(key)
    if (!isChatNode(node) || (node.kind !== 'user' && node.kind !== 'steering')) return []
    const snippets: string[] = []
    for (const block of node.data.content) {
      if (isObjectRecord(block) && block.type === 'text' && typeof block.text === 'string') snippets.push(block.text)
    }
    const preview = snippets.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    return [{ key, preview }]
  }), [order, nodeStore])
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )
  const runningTurnStart = useMemo(() => runningTurnStartTime(timeline), [timeline])

  const listRef = useRef<HTMLDivElement | null>(null)
  const [railHost, setRailHost] = useState<HTMLElement | null>(null)
  const [activeMarker, setActiveMarker] = useState<string | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Last position delivered or written on the main thread. */
  const observedTopRef = useRef(0)
  const readerScrollUntilRef = useRef(0)
  // A resize/anchor correction shortly after an upward gesture is not a
  // downward reader gesture. Only a fresh downward/scrollbar input may re-pin.
  const readerDirectionRef = useRef(0)
  /** Paging anchor: semantic row/position at click, updated by reader scrolls
   * while the request is pending and restored after the prepend lands. */
  const anchorRef = useRef<PagingAnchor | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (which would snap inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)
  const processAnchorRef = useRef<PagingAnchor | null>(null)

  useLayoutEffect(() => {
    const local = listRef.current
    setRailHost(local?.closest<HTMLElement>('[data-conversation-root]') ?? local?.closest<HTMLElement>('[data-chat-view-root]') ?? null)
  }, [sessionId])

  useEffect(() => {
    const local = listRef.current
    if (local === null || messageMarkers.length === 0) { setActiveMarker(null); return }
    const scrollport = scrollerOf(local)
    let frame = 0
    const update = (): void => {
      frame = 0
      const threshold = scrollport.getBoundingClientRect().top + 48
      let current = messageMarkers[0]?.key ?? null
      for (const row of local.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]')) {
        if (row.getBoundingClientRect().top > threshold) break
        current = row.dataset.chatAnchorKey ?? current
      }
      setActiveMarker(previous => previous === current ? previous : current)
    }
    const schedule = (): void => { if (frame === 0) frame = window.requestAnimationFrame(update) }
    schedule()
    scrollport.addEventListener('scroll', schedule, { passive: true })
    return () => {
      scrollport.removeEventListener('scroll', schedule)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [messageMarkers, sessionId])
  const captureAutoFoldAnchor = (commit: boolean): string | undefined => {
    const local = listRef.current
    if (local === null || atBottomRef.current) return undefined
    const port = scrollerOf(local)
    const row = pagingAnchor(local, port)
    const key = row?.dataset.chatAnchorKey
    if (commit && row !== null && key !== undefined) processAnchorRef.current = { key, top: flowTop(row, port) }
    return key
  }
  const { foldedTools, invalidateFoldedTool } = useAdaptiveToolFold(sessionId, listRef, expandedTurns, captureAutoFoldAnchor, nodeStore)

  const toggleTurnProcess = (turn: number): void => {
    const local = listRef.current
    if (local !== null) {
      const scrollport = scrollerOf(local)
      const row = anchorElement(local, `turn-process:${turn}`)
      processAnchorRef.current = row === null ? null : { key: `turn-process:${turn}`, top: flowTop(row, scrollport) }
      // A disclosure click is a reading gesture, not permission to snap to the
      // floor. Release follow before commit/ResizeObserver and keep it released
      // even when a collapsed list temporarily fits inside the viewport.
      atBottomRef.current = false
      setAtBottom(false)
      readerScrollUntilRef.current = 0
      readerDirectionRef.current = 0
    }
    setProcessState(previous => {
      const choices = new Map(previous.sessionId === sessionId && previous.mode === processMode ? previous.choices : [])
      choices.set(turn, !(choices.get(turn) ?? processMode === 'expanded'))
      return { sessionId, mode: processMode, choices }
    })
  }

  useLayoutEffect(() => {
    const local = listRef.current
    const anchor = processAnchorRef.current
    processAnchorRef.current = null
    if (local === null || anchor === null) return
    const scrollport = scrollerOf(local)
    const row = anchorElement(local, anchor.key)
    if (row !== null) scrollport.scrollTop += flowTop(row, scrollport) - anchor.top
    observedTopRef.current = scrollport.scrollTop
    const position = scrollPosition(local, scrollport)
    if (position !== null) chatScroll.save(position)
  }, [expandedTurns, foldedTools, chatScroll])

  // One independently subscribed resident entry per loaded turn, including
  // partial history pages without the original user/start event. No full-turn
  // pinning: only the live tip and pending tools bypass row windowing.
  const processHeads = useMemo(() => {
    const heads = new Set<string>()
    const turns = new Set<number>()
    for (const key of order) {
      const node = nodeStore.get(key)
      if (node?.kind === 'user' || node?.kind === 'steering') continue
      const location = node?.location
      if (location?.kind !== 'turn' && location?.kind !== 'step') continue
      if (turns.has(location.turn.turn)) continue
      turns.add(location.turn.turn)
      heads.add(key)
    }
    return heads
  }, [order, nodeStore, timeline])

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ''}`

  const toBottom = (el: HTMLElement): void => {
    anchorRef.current = null
    processAnchorRef.current = null
    // Explicit/programmatic return ends the previous reader gesture. Delayed
    // resize/clamp scroll events must not inherit an earlier up gesture.
    readerScrollUntilRef.current = 0
    readerDirectionRef.current = 0
    el.scrollTop = el.scrollHeight
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
    chatScroll.save(null)
  }

  useLayoutEffect(() => chatScroll.subscribeFollow?.(() => {
    const local = listRef.current
    if (local !== null) toBottom(scrollerOf(local))
  }), [chatScroll, sessionId])

  useLayoutEffect(() => {
    const local = listRef.current
    if (local === null) return
    return bindTranscriptFollow(scrollerOf(local), atBottomRef)
  }, [])

  useLayoutEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (local === null) return
    const el = scrollerOf(local)
    // Open completed: jump to the bottom once — unless a scroll position
    // survives from a previous mount (view-tab switch away and back), which
    // is restored instead of snapping the reader back to the floor.
    if (openState === 'open' && !openedRef.current) {
      openedRef.current = true
      const saved = chatScroll.read()
      if (saved === null) {
        toBottom(el)
      } else {
        el.scrollTop = saved.scrollTop
        const row = anchorElement(local, saved.anchorKey)
        if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop
        observedTopRef.current = el.scrollTop
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        atBottomRef.current = isAtBottom
        setAtBottom(isAtBottom)
        const normalized = isAtBottom ? null : scrollPosition(local, el)
        if (isAtBottom) chatScroll.save(null)
        else if (normalized !== null) chatScroll.save(normalized)
      }
      firstSeqRef.current = firstSeq
      followSigRef.current = followSig
      return
    }
    // Prepend (head seq decreased): preserve the same settled row at the
    // position established by the reader's latest scroll. This excludes
    // unrelated tail/composer growth while the request was in flight.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      anchorRef.current = null
      const row = anchorElement(local, anchor.key)
      if (row !== null) el.scrollTop += flowTop(row, el) - anchor.top
      observedTopRef.current = el.scrollTop
      firstSeqRef.current = firstSeq
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    // Delivery is not a local send gesture. A restored/other-observer user
    // node or a delayed steering snapshot must not take reader ownership.
    const tipMoved = followSigRef.current !== followSig
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because atBottomRef is true (scroll threshold → setState → snap).
    if (tipMoved && atBottomRef.current) toBottom(el)
  })

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
    if (local === null) return
    const el = scrollerOf(local)
    // Only reader input may make raw scroll geometry change follow ownership:
    // a delivered position that deviates from the observed-top ledger (every
    // programmatic write records itself there synchronously). This covers
    // wheel, touch, scrollbar, and keyboard alike without naming devices.
    // Browser shrink-clamps land exactly on the floor min and delayed
    // programmatic deliveries land on the ledger itself, so both preserve
    // the current ownership state.
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const readerInputRecent = Date.now() <= readerScrollUntilRef.current
    const movedByReader = readerInputRecent && Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5
    const isAtBottom = scrollFollowAtBottom(atBottomRef.current, el.scrollTop, floor, observedTopRef.current,
      readerInputRecent && (atBottomRef.current || readerDirectionRef.current >= 0))
    if (!movedByReader && isAtBottom) {
      toBottom(el)
      return
    }
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    const position = isAtBottom ? null : scrollPosition(local, el)
    if (isAtBottom) {
      anchorRef.current = null
    } else if (anchorRef.current !== null && position !== null) {
      anchorRef.current = { key: position.anchorKey, top: position.anchorTop }
    }
    // Continuous save (unmount happens after ref detach, so saving there is
    // too late); pinned-to-bottom clears so a remount keeps following.
    if (isAtBottom) chatScroll.save(null)
    else if (position !== null) chatScroll.save(position)
    observedTopRef.current = el.scrollTop
  }

  // Gesture intent is delivered before scroll/resize/layout callbacks. Release
  // follow synchronously when the reader starts moving up, even a few pixels
  // inside FOLLOW_THRESHOLD. Otherwise streaming can win that first frame.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = (): void => { onScrollRef.current() }
    const markReaderInput = (direction?: number): void => {
      readerScrollUntilRef.current = Date.now() + 1500
      if (direction !== undefined) readerDirectionRef.current = direction
    }
    const pauseFollowing = (): void => {
      atBottomRef.current = false
      setAtBottom(false)
    }
    const onWheel = (event: WheelEvent): void => {
      // Ctrl-wheel/pinch zoom and horizontal-only movement are not read-up.
      if (event.ctrlKey || event.deltaY === 0) return
      markReaderInput(Math.sign(event.deltaY))
      if (event.deltaY < 0) pauseFollowing()
    }
    let touchY: number | null = null
    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0]
      touchY = event.touches.length === 1 && touch !== undefined ? touch.clientY : null
    }
    const onTouchMove = (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (event.touches.length !== 1 || touch === undefined) { touchY = null; return }
      const y = touch.clientY
      markReaderInput(touchY === null ? -1 : y === touchY ? undefined : Math.sign(touchY - y))
      if (touchY === null || y > touchY) pauseFollowing()
      touchY = y
    }
    const onTouchEnd = (): void => { touchY = null }
    let readerPointer: number | null = null
    const onPointer = (event: PointerEvent): void => {
      if (event.target !== el || event.button !== 0) return
      readerPointer = event.pointerId
      markReaderInput(0)
      pauseFollowing()
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId === readerPointer) markReaderInput()
    }
    const onPointerEnd = (event: PointerEvent): void => {
      if (event.pointerId === readerPointer) readerPointer = null
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || (event.target instanceof Element
        && event.target.closest('input,textarea,[contenteditable=true],[role=menu],[role=listbox],[role=combobox]'))) return
      if (event.key === ' ' && event.target instanceof Element && event.target.closest('button,a')) return
      if (!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) return
      const upward = ['ArrowUp','PageUp','Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)
      markReaderInput(upward ? -1 : 1)
      if (upward) pauseFollowing()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('pointerdown', onPointer)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
      el.removeEventListener('keydown', onKey)
    }
  }, [])

  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const local = listRef.current
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      chatScroll.save(null)
    }
  }
  // Streaming, tool disclosures, and other flow changes resize the column;
  // the sticky composer resizes outside it. This observer owns ChatView's
  // dynamic-height follow decisions and writes only while the reader is pinned.
  useEffect(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === 'undefined') return
    const scrollport = scrollerOf(local)
    const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
    const observer = new ResizeObserver(() => { followRef.current?.() })
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    return () => { observer.disconnect() }
  }, [])

  // A failed/empty page leaves the head unchanged. Once the request leaves
  // its busy state there is no future prepend for the saved anchor to own.
  useEffect(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])

  const loadOlderAnchored = (): void => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          top: flowTop(row, el),
        }
      }
    }
    loadOlder()
  }

  const scrollToMessage = (key: string): void => {
    const local = listRef.current
    if (local === null) return
    const row = anchorElement(local, key)
    if (row === null) return
    const scrollport = scrollerOf(local)
    atBottomRef.current = false
    setAtBottom(false)
    readerScrollUntilRef.current = 0
    readerDirectionRef.current = 0
    scrollport.scrollTop += flowTop(row, scrollport) - 24
    observedTopRef.current = scrollport.scrollTop
    setActiveMarker(key)
    const position = scrollPosition(local, scrollport)
    if (position !== null) chatScroll.save(position)
  }

  return (
    <div className={css.root} data-chat-view-root="">
      {railHost !== null && messageMarkers.length > 1 && createPortal(
        <nav className={railCss.root} aria-label={t('chat.messageRail')}>
          {messageMarkers.map((marker, index) => {
            const label = marker.preview === ''
              ? t('chat.messageRail.message', { n: index + 1 })
              : `${t('chat.messageRail.message', { n: index + 1 })}: ${marker.preview}`
            return <Tooltip key={marker.key} label={label} side="right" delayMs={300}>
              <button
                type="button"
                className={railCss.item}
                data-message-key={marker.key}
                aria-label={label}
                aria-current={activeMarker === marker.key ? 'location' : undefined}
                onClick={() => { scrollToMessage(marker.key) }}
              ><span className={railCss.mark} aria-hidden="true" /></button>
            </Tooltip>
          })}
        </nav>,
        railHost,
      )}
      <div ref={listRef} className={css.scroll}>
        <div ref={columnRef} className={css.column} data-chat-flow="">
          {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
          {openState === 'error' && openError !== null && (
            <div className={css.openError} role="alert">
              {t('chat.loadError', { message: openError.message, code: openError.code })}
              <button type="button" data-history-retry="" onClick={loadOlder}>{t('retry')}</button>
            </div>
          )}
          {hasMore && (
            <div className={css.older}>
              <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>
                {loadingOlder ? t('loading') : t('chat.loadOlder')}
              </button>
            </div>
          )}
          {order.flatMap((nodeKey) => [
            ...(processHeads.has(nodeKey) ? [<TurnProcessSummarySeat
              key={`${sessionId}:process:${nodeKey}`}
              nodeKey={nodeKey}
              useSession={useSession}
              expandedTurns={expandedTurns}
              foldedTools={foldedTools}
              toggleTurnProcess={toggleTurnProcess}
              t={t}
            />] : []),
            <ChatNodeSeat
              key={`${sessionId}:node:${nodeKey}`}
              nodeKey={nodeKey}
              expandedTurns={expandedTurns}
              foldedTools={foldedTools}
              invalidateFoldedTool={invalidateFoldedTool}
              keepMounted={running && (nodeKey === lastKey || transcriptHasPendingTool(nodeStore.get(nodeKey)))}
              editMessage={editMessage}
              forkMessage={forkMessage}
              editAvailable={!running}
              useSession={useSession}
              selectedCallId={selectedCallId}
              cwd={cwd}
              openFile={requestOpenFile}
              inspectCall={inspectCall}
              forkAt={forkAt}
              renderMessageImages={renderMessageImages}
              fileMentions={fileMentions}
              renderSlot={renderSlot}
              t={t}
            />,
          ])}
          {/* No pending placeholders: questions (ui-user-questions) and approvals
              (ApprovalPanel) both take over the composer, so a flow card would
              double-render the same wait. */}
          {/* Turn-level loading signal: rides the whole running turn (first-token
              wait, tool execution, streaming) so it never flickers per step. */}
          {running && <TurnStatus startTime={runningTurnStart} t={t} />}
          {pendingSteering.map(item => (
            <PendingSteeringBubble
              key={item.id}
              content={item.content}
              renderMessageImages={renderMessageImages}
              t={t}
            />
          ))}
        </div>
        {!atBottom && (
          <div className={css.toBottomSlot}>
            <button
              type="button"
              className={css.toBottom}
              aria-label={t('chat.toBottom')}
              onClick={() => {
                const local = listRef.current
                /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                if (local !== null) toBottom(scrollerOf(local))
              }}
            >
              <IconChevronDownOutline14 />
            </button>
          </div>
        )}
      </div>
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          path={fileOpenError.path}
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({
  path, message, busy, onClose, onRetry, t,
}: {
  path: string
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: ChatViewSlotProps['t']
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t(isFolderOpenPath(path) ? 'fileOpen.folderTitle' : 'fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}

/** Native clamp/compaction is not reader input and cannot steal follow ownership. */
export function scrollFollowAtBottom(current: boolean, top: number, floor: number, observed: number, recentInput: boolean): boolean {
  const delta = top - Math.min(observed, floor)
  if (!recentInput || Math.abs(delta) <= 0.5) return current
  // Near-bottom tolerance is for downward re-entry, never for cancelling an
  // upward gesture. A layout shrink/clamp without movement keeps ownership.
  return delta > 0 && floor - top <= FOLLOW_THRESHOLD + 1
}
