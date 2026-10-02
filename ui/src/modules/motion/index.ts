/// <reference path="../shared/assets.d.ts" />
import CSS from './Motion.css'
import type { EffectContext } from '../shared/runtime-types'


const STYLE_ID = 'xharness-stream-motion-style'
// Markdown block tags whose first appearance is animated. Inline churn
// (spans re-rendered as text grows) never matches, so only new blocks
// fade — the effect is paragraph-level, like ZCode's.
const STREAM_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'UL', 'OL',
  'TABLE', 'BLOCKQUOTE', 'IMG', 'HR',
])
const STAGGER_MS = 45
const MAX_STAGGER_STEPS = 5
// React re-renders a growing block by replacing it; consecutive additions
// into the same parent within this window are treated as that churn.
const CHURN_WINDOW_MS = 300


// ---------------------------------------------------------------- core --
// Pure planner so the selection rules are testable without a DOM. The
// Element interface used: tagName, parentElement, contains, closest.
function hasElementShape(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && 'tagName' in value && typeof value.tagName === 'string'
}

function planStreamAnimations(added: Iterable<unknown, unknown, unknown>, lastRow: Element | null, now: number, recent: WeakMap<Element, number>) {
  const candidates: HTMLElement[] = []
  for (const node of added) {
    if (node === null || node === undefined) continue
    if (!hasElementShape(node)) continue
    if (lastRow === null || lastRow === undefined) continue
    if (!lastRow.contains(node)) continue
    if (node.closest('[data-transcript-mounted="false"]') !== null) continue
    if (node.closest('[data-xh-stream-animate="true"]') !== null) continue
    if (!STREAM_TAGS.has(node.tagName)) continue
    candidates.push(node)
  }
  // Nested targets (a P inside an added LI) animate once, on the ancestor.
  const deduped: HTMLElement[] = []
  for (const node of candidates) {
    if (candidates.some((other) => other !== node && other.contains(node))) continue
    deduped.push(node)
  }
  // Churn suppression is cross-batch only: siblings arriving in the same
  // batch stagger together, while re-renders of the same parent within
  // the window stay suppressed (the window refreshes on every hit).
  const kept: HTMLElement[] = []
  const touched = new Set<Element>()
  for (const node of deduped) {
    const parent = node.parentElement
    if (parent !== null && !touched.has(parent)) {
      const last = recent.get(parent) ?? 0
      if (now - last < CHURN_WINDOW_MS) {
        recent.set(parent, now)
        touched.add(parent)
        continue
      }
    }
    kept.push(node)
  }
  for (const node of kept) {
    const parent = node.parentElement
    if (parent !== null) {
      recent.set(parent, now)
      touched.add(parent)
    }
  }
  return kept.map((node, index) => ({
    node,
    delayMs: Math.min(index, MAX_STAGGER_STEPS) * STAGGER_MS,
  }))
}

// ---------------------------------------------------------- wiring --

function lastTranscriptRow(root: Element) {
  const rows = root.querySelectorAll('[data-transcript-mounted]')
  return rows.length > 0 ? rows[rows.length - 1] ?? null : null
}

function turnActive() {
  // The upstream turn-status bar only exists while a turn runs; its
  // hashed class keeps the semantic `turnStatus` suffix.
  return document.querySelector('[class*="_turnStatus"]') !== null
}

function applyAnimation(node: HTMLElement, delayMs: number) {
  node.setAttribute('data-xh-stream-animate', 'true')
  if (delayMs > 0) node.style.setProperty('--xh-stream-delay', `${delayMs}ms`)
  const done = (event: AnimationEvent) => {
    if (event.target !== node) return
    node.removeEventListener('animationend', done)
    node.removeAttribute('data-xh-stream-animate')
    node.style.removeProperty('--xh-stream-delay')
  }
  node.addEventListener('animationend', done)
}

function observeRoot(root: Element) {
  if (roots.has(root)) return
  roots.add(root)
  // Weak keys avoid retaining every replaced markdown parent for the
  // lifetime of a long-running conversation.
  const recent = new WeakMap<Element, number>()
  let pending: Node[] = []
  let flush = 0
  const drain = () => {
    flush = 0
    if (reduced()) return
    if (!turnActive()) {
      pending = []
      return
    }
    const added = pending
    pending = []
    for (const { node, delayMs } of planStreamAnimations(
      added,
      lastTranscriptRow(root),
      Date.now(),
      recent,
    )) {
      applyAnimation(node, delayMs)
    }
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) pending.push(node)
    }
    if (pending.length > 0 && flush === 0) flush = setTimeout(drain, 40)
  })
  observer.observe(root, { childList: true, subtree: true })
  teardown.set(root, () => {
    observer.disconnect()
    roots.delete(root)
    if (flush !== 0) clearTimeout(flush)
  })
}

const roots = new Set<Element>()
const teardown = new Map<Element, () => void>()
let rootFinder: MutationObserver | null = null

function reduced() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
}

const inject: string[] = []

function apply(ctx: EffectContext) {
  ctx.effect(() => {
    const existing = document.getElementById(STYLE_ID)
    if (existing !== null) return () => {}
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'xharness-ui-motion: styles')
  ctx.effect(() => {
    for (const node of document.querySelectorAll('[data-conversation-scroll]')) {
      observeRoot(node)
    }
    // The transcript mounts long after the plugin loads; follow the body
    // until every scroller has been claimed, then stop looking.
    rootFinder = new MutationObserver((records) => {
      // Conversation scrollers are remounted on navigation. Release their
      // observers rather than retaining detached transcript trees forever.
      for (const root of roots) {
        if (!root.isConnected) {
          teardown.get(root)?.()
          teardown.delete(root)
        }
      }
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.hasAttribute('data-conversation-scroll')) observeRoot(node)
          for (const found of node.querySelectorAll('[data-conversation-scroll]')) {
            observeRoot(found)
          }
        }
      }
    })
    rootFinder.observe(document.body, { childList: true, subtree: true })
    return () => {
      rootFinder?.disconnect()
      rootFinder = null
      for (const dispose of teardown.values()) dispose()
      teardown.clear()
      roots.clear()
    }
  }, 'xharness-ui-motion: stream observer')
}


export { apply, inject, planStreamAnimations, STREAM_TAGS, CHURN_WINDOW_MS }
