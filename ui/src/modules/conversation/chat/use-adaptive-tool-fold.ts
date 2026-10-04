import { useLayoutEffect, useRef, useState } from 'react'
import { useProcessMode } from './process-mode'
import type { ChatConversationViewNode } from '../types/runtime'
import { NO_FOLDED_TOOLS, planToolFold, type FoldedTools, type ToolFoldRow } from './adaptive-tool-fold'

/** One observer per chat, not per Tool. No transport/event parsing in this seat. */
export function useAdaptiveToolFold(sessionId: string, list: React.RefObject<HTMLElement>, expanded: ReadonlySet<number>,
  beforeFold: (commit: boolean) => string | undefined, revision: Pick<ReadonlyMap<string, ChatConversationViewNode>, 'get'>): FoldedTools {
  const mode = useProcessMode()
  const [state, setState] = useState<{ sessionId: string; folded: FoldedTools }>(() => ({ sessionId, folded: NO_FOLDED_TOOLS }))
  if (state.sessionId !== sessionId) setState({ sessionId, folded: NO_FOLDED_TOOLS })
  const latest = useRef({ expanded, beforeFold, revision })
  latest.current = { expanded, beforeFold, revision }
  const scheduleRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    if (mode === 'expanded') {
      setState({ sessionId, folded: NO_FOLDED_TOOLS })
      return
    }
    const root = list.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const elementRoot = root
    const scrollport = root.closest<HTMLElement>('[data-conversation-scroll]') ?? root
    let frame = 0, disposed = false
    const observed = new Set<HTMLElement>(), manuallyOpened = new Set<string>()
    const schedule = (): void => {
      if (disposed || frame) return
      frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(scrollport)
    // ChatNodeStore is deliberately stable/mutable. A lifecycle update may
    // change eligibility without changing its identity or the row height.
    const mutations = new MutationObserver(schedule)
    mutations.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-chat-auto-fold-turn', 'data-chat-auto-fold-eligible'] })
    function measure(): void {
      frame = 0
      const elements = [...elementRoot.querySelectorAll<HTMLElement>('[data-chat-auto-fold-turn]')]
      const current = new Set(elements)
      for (const key of manuallyOpened) {
        const location = latest.current.revision.get(key)?.location
        if ((location?.kind !== 'turn' && location?.kind !== 'step') || location.turn.status !== 'open') manuallyOpened.delete(key)
      }
      for (const element of observed) if (!current.has(element)) { observer.unobserve(element); observed.delete(element) }
      for (const element of elements) if (!observed.has(element)) { observer.observe(element); observed.add(element) }
      const selection = document.getSelection()
      const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
      const rows: ToolFoldRow[] = []
      const readerAnchor = latest.current.beforeFold(false)
      for (const element of elements) {
        const turn = Number(element.dataset.chatAutoFoldTurn), key = element.dataset.chatFlowKey
        if (key === undefined || latest.current.expanded.has(turn)) continue
        const gap = Number.parseFloat(element.parentElement ? getComputedStyle(element.parentElement).rowGap : '0')
        rows.push({ key, turn, height: element.getBoundingClientRect().height + (Number.isFinite(gap) ? gap : 0),
          eligible: element.dataset.chatAutoFoldEligible === 'true',
          protected: manuallyOpened.has(key) || key === readerAnchor || element.contains(document.activeElement)
            || !!(range && range.intersectsNode(element)) })
      }
      // The composer occupies part of the scrollport. Never use its space as
      // a tool budget, and never react to a hidden/zero-height chat viewport.
      const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
      const viewport = scrollport.getBoundingClientRect()
      const visibleHeight = Math.min(scrollport.clientHeight, (composer?.getBoundingClientRect().top ?? viewport.bottom) - viewport.top)
      const hidden = planToolFold(rows, visibleHeight)
      if (hidden.size > 0) latest.current.beforeFold(true)
      setState(previous => {
        if (disposed || previous.sessionId !== sessionId) return previous
        const folded = new Map<number, Set<string>>()
        let changed = false
        // Display bookkeeping must not grow with every historical turn.
        // Closed/deleted turns need only the existing authoritative tail fold.
        for (const [turn, keys] of previous.folded) {
          const kept = new Set<string>()
          for (const key of keys) {
            const location = latest.current.revision.get(key)?.location
            if ((location?.kind === 'turn' || location?.kind === 'step') && location.turn.status === 'open') kept.add(key)
          }
          if (kept.size) folded.set(turn, kept)
          if (kept.size !== keys.size) changed = true
        }
        for (const row of rows) if (hidden.has(row.key)) {
          const keys = folded.get(row.turn) ?? new Set<string>()
          if (keys.has(row.key)) continue
          keys.add(row.key); folded.set(row.turn, keys); changed = true
        }
        return changed ? { sessionId, folded } : previous
      })
    }
    const onClick = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      const disclosure = target?.closest('button[aria-expanded],summary')
      const row = disclosure?.closest<HTMLElement>('[data-chat-auto-fold-turn]')
      const key = row?.dataset.chatFlowKey
      if (key && (disclosure?.getAttribute('aria-expanded') === 'false'
        || disclosure?.parentElement instanceof HTMLDetailsElement && !disclosure.parentElement.open)) manuallyOpened.add(key)
      schedule()
    }
    root.addEventListener('click', onClick, true)
    root.addEventListener('focusout', schedule)
    document.addEventListener('selectionchange', schedule)
    scheduleRef.current = schedule
    schedule()
    return () => {
      disposed = true; if (frame) cancelAnimationFrame(frame)
      scheduleRef.current = () => {}
      mutations.disconnect(); observer.disconnect(); observed.clear(); manuallyOpened.clear()
      root.removeEventListener('click', onClick, true)
      root.removeEventListener('focusout', schedule)
      document.removeEventListener('selectionchange', schedule)
    }
  }, [sessionId, list, mode])
  // New/settled nodes and explicit choices may change eligibility without
  // changing geometry. Observe them without tearing down the ResizeObserver.
  useLayoutEffect(() => { scheduleRef.current() }, [revision, expanded, state])
  return mode === 'auto' && state.sessionId === sessionId ? state.folded : NO_FOLDED_TOOLS
}
