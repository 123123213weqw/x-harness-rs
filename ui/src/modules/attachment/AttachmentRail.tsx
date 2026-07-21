import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseFill14 } from '@xharness/dsh-client-ui-primitives'
import type { RailItem, RailLabels } from './contracts'
import { AttachmentRailCss as css } from './styles'
import { FileCard } from './FileCard'
const WHEEL_LINE_PX = 16
function pageBehavior(): ScrollBehavior { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }
export function AttachmentRail({ items, labels, onOpen, onRemove }: { items: readonly RailItem[]; labels: RailLabels; onOpen(item: RailItem): void; onRemove(item: RailItem): void }) {
  const railRef = useRef<HTMLDivElement | null>(null), countRef = useRef<number | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const updateEdges = useCallback(() => {
    const element = railRef.current
    if (element === null) return
    const left = element.scrollLeft > 1, right = element.scrollLeft < element.scrollWidth - element.clientWidth - 1
    setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right })
  }, [])
  useLayoutEffect(() => {
    const grew = countRef.current !== null && items.length > countRef.current; countRef.current = items.length
    const element = railRef.current
    if (element === null) return
    if (grew) element.scrollLeft = element.scrollWidth - element.clientWidth
    updateEdges()
  }, [items.length, updateEdges])
  useEffect(() => {
    const element = railRef.current
    if (element === null) return
    let disconnect = () => {}
    if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(updateEdges); observer.observe(element); disconnect = () => { observer.disconnect() } }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1
      event.preventDefault()
      element.scrollBy({ left: event.deltaX !== 0 ? event.deltaX * scale : Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY) * scale, 60), behavior: 'auto' })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { disconnect(); element.removeEventListener('wheel', onWheel) }
  }, [updateEdges])
  const page = (direction: number) => { const element = railRef.current; if (element !== null) element.scrollBy({ left: direction * Math.max(element.clientWidth - 64, 200), behavior: pageBehavior() }) }
  return <div className={css.root}>
    {edges.left && <button type="button" className={`${css.arrow} ${css.arrowLeft}`} aria-label={labels.scrollLeft} onClick={() => { page(-1) }}><IconChevronLeftOutline14 /></button>}
    <div ref={railRef} className={css.rail} role="group" aria-label={labels.group} onScroll={updateEdges}>
      {items.map(item => item.attachment.kind === 'file' ? <FileCard name={item.attachment.file.name} bytes={item.attachment.file.size} onRemove={() => { onRemove(item) }} removeLabel={item.removeLabel} key={item.id} /> : <div className={css.item} key={item.id}>
        <button type="button" className={css.thumbnail} title={labels.open} onClick={() => { onOpen(item) }}><img src={item.previewUrl} alt={item.alt} /></button>
        <button type="button" className={css.remove} aria-label={item.removeLabel} onClick={() => { onRemove(item) }}><IconCloseFill14 size={12} /></button>
      </div>)}
    </div>
    {edges.right && <button type="button" className={`${css.arrow} ${css.arrowRight}`} aria-label={labels.scrollRight} onClick={() => { page(1) }}><IconChevronRightOutline14 /></button>}
  </div>
}
