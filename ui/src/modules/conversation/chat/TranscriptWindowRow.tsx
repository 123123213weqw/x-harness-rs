import * as React from 'react'
import type { HTMLAttributes } from 'react'
import { transcriptState, transcriptStateFor, type TranscriptValues } from './transcript-state'

type View = { mounted: boolean; height: number }
type Binding = { keep(value: boolean): void; focus(value: boolean): void; remove(): void }
type Row = View & { element: HTMLElement; update(view: View): void; keep: boolean; focused: boolean; selected: boolean; near: boolean }
type Controller = { add(element: HTMLElement, update: (view: View) => void, keep: boolean, estimate: number): Binding }
const roots = new WeakMap<HTMLElement, Controller>()
const followOwners = new WeakMap<HTMLElement, Readonly<{ current: boolean }>>()

/** ChatView owns reader intent; measuring rows must not infer it a second time. */
export function bindTranscriptFollow(root: HTMLElement, owner: Readonly<{ current: boolean }>): () => void {
  followOwners.set(root, owner)
  return () => {
    if (followOwners.get(root) === owner) followOwners.delete(root)
  }
}

/** Product-owned bounded transcript DOM. Heavy children are mounted near the viewport only. */
function controller(root: HTMLElement): Controller {
  const previous = roots.get(root)
  if (previous) return previous
  const rows = new Map<Element, Row>()
  let frame = 0, width = root.clientWidth, height = root.clientHeight
  let intersection: IntersectionObserver
  let anchor: { element: HTMLElement; top: number } | null = null
  let following = false
  const viewportTop = (): number => root.getBoundingClientRect().top
  function remember(): void {
    following = followOwners.get(root)?.current ?? (root.scrollHeight - root.scrollTop - root.clientHeight <= 25)
    const top = viewportTop()
    anchor = null
    for (const row of rows.values()) {
      if (!row.near && !row.mounted) continue
      const rect = row.element.getBoundingClientRect()
      if (rect.bottom > top && rect.top < top + root.clientHeight && (!anchor || rect.top < anchor.top + top)) {
        anchor = { element: row.element, top: rect.top - top }
      }
    }
  }
  function compensate(): void {
    if (getComputedStyle(root).overflowAnchor === 'none') {
      // Read the live ref here too: upward intent may arrive after remember(),
      // before ResizeObserver. Geometry alone must not take ownership back.
      if (followOwners.get(root)?.current ?? following) root.scrollTop = root.scrollHeight
      else if (anchor?.element.isConnected && rows.has(anchor.element)) {
        root.scrollTop += anchor.element.getBoundingClientRect().top - viewportTop() - anchor.top
      }
    }
    remember()
  }
  const measure = new ResizeObserver(entries => {
    for (const entry of entries) {
      const row = rows.get(entry.target)
      if (!row?.mounted) continue
      const measured = entry.target.getBoundingClientRect().height
      if (Number.isFinite(measured) && measured >= 0) row.height = measured
    }
    compensate()
  })
  function schedule(): void {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      for (const row of rows.values()) {
        const show = row.near || row.focused || row.selected || row.keep
        if (show === row.mounted) continue
        row.mounted = show
        row.update({ mounted: show, height: row.height })
      }
    })
  }
  function observe(): void {
    intersection?.disconnect()
    intersection = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const row = rows.get(entry.target)
        if (row) row.near = entry.isIntersecting
      }
      if (!anchor) remember()
      schedule()
    }, { root, rootMargin: `${Math.max(1, root.clientHeight)}px 0px` })
    for (const element of rows.keys()) intersection.observe(element)
  }
  const rootObserver = new ResizeObserver(() => {
    const nextWidth = root.clientWidth, nextHeight = root.clientHeight
    if (nextWidth === width && nextHeight === height) return
    width = nextWidth; height = nextHeight
    // Offscreen heights stay estimates after reflow. Never materialize the full history.
    observe()
    compensate()
  })
  rootObserver.observe(root)
  observe()
  function selectionChanged(): void {
    const selection = document.getSelection()
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
    for (const row of rows.values()) row.selected = !!(range && row.mounted && range.intersectsNode(row.element))
    schedule()
  }
  root.addEventListener('scroll', remember, { passive: true })
  document.addEventListener('selectionchange', selectionChanged)
  const result: Controller = {
    add(element, update, keep, estimate) {
      const row: Row = { element, update, keep, focused: false, selected: false, near: false, mounted: keep, height: estimate }
      rows.set(element, row)
      measure.observe(element)
      intersection.observe(element)
      if (rows.size === 1) remember()
      return {
        keep(value) { row.keep = value; schedule() },
        focus(value) { row.focused = value; schedule() },
        remove() {
          rows.delete(element); measure.unobserve(element); intersection.unobserve(element)
          if (rows.size) return
          if (frame) cancelAnimationFrame(frame)
          root.removeEventListener('scroll', remember)
          document.removeEventListener('selectionchange', selectionChanged)
          rootObserver.disconnect(); intersection.disconnect(); measure.disconnect()
          roots.delete(root)
        },
      }
    },
  }
  roots.set(root, result)
  return result
}

function detailKey(node: HTMLDetailsElement, index: number): string {
  return node.getAttribute('data-transcript-state-key') || node.id || `${index}:${node.querySelector('summary')?.textContent?.slice(0, 120) ?? ''}`
}

export function TranscriptWindowRow({ children, keepMounted = false, estimatedHeight = 240, presentationState, ...attributes }: HTMLAttributes<HTMLDivElement> & { keepMounted?: boolean; estimatedHeight?: number; presentationState?: TranscriptValues; onToggleCapture?: (event: React.SyntheticEvent<HTMLDivElement>) => void }) {
  const element = React.useRef<HTMLDivElement>(null), binding = React.useRef<Binding | null>(null)
  // The keyed Node seat may outlive a folded/unmounted WindowRow. Use its
  // lightweight state when provided; standalone window rows retain their own.
  const values = React.useRef(presentationState ?? new Map<string, unknown>())
  const estimate = Number.isFinite(estimatedHeight) && estimatedHeight > 0 ? estimatedHeight : 240
  const [view, setView] = React.useState<View>({ mounted: keepMounted, height: estimate })
  React.useLayoutEffect(() => {
    const node = element.current, root = node?.closest<HTMLElement>('[data-conversation-scroll]')
    if (!node || !root || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') {
      setView(value => ({ ...value, mounted: true }))
      return
    }
    const handle = controller(root).add(node, setView, keepMounted, estimate)
    binding.current = handle
    return () => { handle.remove(); binding.current = null }
  }, [])
  React.useLayoutEffect(() => { binding.current?.keep(keepMounted) }, [keepMounted])
  React.useLayoutEffect(() => {
    if (!view.mounted) return
    element.current?.querySelectorAll('details').forEach((node, index) => {
      const restored = values.current.get('native-details:' + detailKey(node, index))
      if (typeof restored === 'boolean') node.open = restored
    })
  }, [view.mounted])
  const focusedInput = (): boolean => {
    const active = document.activeElement
    return !!(active && element.current?.contains(active) && active.matches('input,textarea,select,[contenteditable="true"]'))
  }
  const onToggle = (event: React.SyntheticEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLDetailsElement)) return
    const nodes = [...element.current?.querySelectorAll('details') ?? []]
    const index = nodes.indexOf(target)
    if (index >= 0) values.current.set('native-details:' + detailKey(target, index), target.open)
  }
  return <div {...attributes} ref={element} data-transcript-mounted={view.mounted ? 'true' : 'false'}
    onFocusCapture={event => { attributes.onFocusCapture?.(event); binding.current?.focus(focusedInput()) }}
    onBlurCapture={event => { attributes.onBlurCapture?.(event); queueMicrotask(() => binding.current?.focus(focusedInput())) }}
    {...{ onToggleCapture: (event: React.SyntheticEvent<HTMLDivElement>) => { attributes.onToggleCapture?.(event); onToggle(event) } }}
    style={view.mounted ? attributes.style : { ...attributes.style, display: 'block', height: view.height, boxSizing: 'border-box' }}>
    {view.mounted ? <transcriptState.Context.Provider value={values.current}>{children}</transcriptState.Context.Provider> : null}
  </div>
}

/** Module-loader namespace wrappers share one React createElement identity. */
export function createTranscriptWindowing(react: Pick<typeof React, 'createElement'>): typeof TranscriptWindowRow {
  transcriptStateFor(react)
  return TranscriptWindowRow
}
