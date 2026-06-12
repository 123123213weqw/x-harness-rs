// Streaming text fade-in for the conversation transcript. New content blocks
// inside the streaming (last) message row fade in with a small stagger,
// adapted from the Apache-2.0 zai-org/ZCode stream animation. DOM-level by
// design: no upstream bundle patching, and windowing remounts are skipped.
window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-motion',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

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
    const FADE_DURATION_MS = 900

    const CSS = `
@keyframes xh-stream-in{from{opacity:0}to{opacity:1}}
[data-xh-stream-animate="true"]{animation:xh-stream-in ${FADE_DURATION_MS}ms cubic-bezier(.16,1,.3,1) both;animation-delay:var(--xh-stream-delay,0ms);will-change:opacity}
@media (prefers-reduced-motion:reduce){[data-xh-stream-animate="true"]{animation:none}}
`

    // ---------------------------------------------------------------- core --
    // Pure planner so the selection rules are testable without a DOM. The
    // Element interface used: tagName, parentElement, contains, closest.
    function planStreamAnimations(added, lastRow, now, recent) {
      const candidates = []
      for (const node of added) {
        if (node === null || node === undefined) continue
        if (typeof node.tagName !== 'string') continue
        if (lastRow === null || lastRow === undefined) continue
        if (!lastRow.contains(node)) continue
        if (node.closest('[data-transcript-mounted="false"]') !== null) continue
        if (node.closest('[data-xh-stream-animate="true"]') !== null) continue
        if (!STREAM_TAGS.has(node.tagName)) continue
        candidates.push(node)
      }
      // Nested targets (a P inside an added LI) animate once, on the ancestor.
      const deduped = []
      for (const node of candidates) {
        if (candidates.some((other) => other !== node && other.contains(node))) continue
        deduped.push(node)
      }
      // Churn suppression is cross-batch only: siblings arriving in the same
      // batch stagger together, while re-renders of the same parent within
      // the window stay suppressed (the window refreshes on every hit).
      const kept = []
      const touched = new Set()
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

    function lastTranscriptRow(root) {
      const rows = root.querySelectorAll('[data-transcript-mounted]')
      return rows.length > 0 ? rows[rows.length - 1] : null
    }

    function turnActive() {
      // The upstream turn-status bar only exists while a turn runs; its
      // hashed class keeps the semantic `turnStatus` suffix.
      return document.querySelector('[class*="_turnStatus"]') !== null
    }

    function applyAnimation(node, delayMs) {
      node.setAttribute('data-xh-stream-animate', 'true')
      if (delayMs > 0) node.style.setProperty('--xh-stream-delay', `${delayMs}ms`)
      const done = (event) => {
        if (event.target !== node) return
        node.removeEventListener('animationend', done)
        node.removeAttribute('data-xh-stream-animate')
        node.style.removeProperty('--xh-stream-delay')
      }
      node.addEventListener('animationend', done)
    }

    function observeRoot(root) {
      if (roots.has(root)) return
      roots.add(root)
      // Weak keys avoid retaining every replaced markdown parent for the
      // lifetime of a long-running conversation.
      const recent = new WeakMap()
      let pending = []
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

    const roots = new Set()
    const teardown = new Map()
    let rootFinder = null

    function reduced() {
      return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    }

    const inject = []

    function apply(ctx) {
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

    exports.apply = apply
    exports.inject = inject
    exports.planStreamAnimations = planStreamAnimations
    exports.STREAM_TAGS = STREAM_TAGS
    exports.CHURN_WINDOW_MS = CHURN_WINDOW_MS
    return module.exports
  },
})
