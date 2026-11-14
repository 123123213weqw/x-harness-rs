import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatViewSlotProps } from '../contract/slots'
import { ToolGlyph } from '../../shared/ToolGlyph'
import { decodeToolActivity, selectToolActivity, type ToolActivityItem } from './tool-activity'
import { useToolActivity } from './use-tool-activity'

/** Decorative recent activity only. The real keyed cards remain the sole action/approval/privacy owner. */
export function ToolActivitySummary({ turn, enabled, useSession, t }: { turn: number; enabled: boolean; useSession: ChatViewSlotProps['useSession']; t: ChatViewSlotProps['t'] }) {
  const value = useSession(snapshot => {
    if (!enabled || !snapshot.running || snapshot.stopRequested || snapshot.openState !== 'open' || (snapshot.pending?.length ?? 0) > 0
      || snapshot.chat.timeline.turns.get(turn)?.status !== 'open') return ''
    let latest = snapshot.chat.timeline.turnOrder?.at(-1)
    if (latest === undefined) for (const id of snapshot.chat.timeline.turns.keys()) latest = id
    if (latest !== turn) return ''
    return selectToolActivity(snapshot.chat.locations.getTurn(turn), key => snapshot.chat.nodes.get(key))
  })
  const input = useMemo(() => decodeToolActivity(value), [value])
  const element = useRef<HTMLSpanElement>(null)
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [selected, setSelected] = useState(false)
  const frame = useToolActivity(input, enabled && value !== '', hovered || focused || selected)
  useLayoutEffect(() => {
    const node = element.current, button = node?.closest('button')
    if (node === null || button == null) return
    let disposed = false
    const focus = (): void => { if (!disposed) setFocused(button.matches(':focus-visible')) }
    const blur = (): void => { queueMicrotask(focus) }
    const keyboard = (): void => { queueMicrotask(focus) }
    const pointer = (): void => { setFocused(false) }
    const selection = (): void => {
      const value = document.getSelection()
      setSelected(!!(value && !value.isCollapsed && value.rangeCount && value.getRangeAt(0).intersectsNode(node)))
    }
    button.addEventListener('focus', focus); button.addEventListener('blur', blur); button.addEventListener('keydown', keyboard); button.addEventListener('pointerdown', pointer); document.addEventListener('selectionchange', selection)
    return () => { disposed = true; button.removeEventListener('focus', focus); button.removeEventListener('blur', blur); button.removeEventListener('keydown', keyboard); button.removeEventListener('pointerdown', pointer); document.removeEventListener('selectionchange', selection) }
  }, [])
  const face = (item: ToolActivityItem, outgoing: boolean) => <span className={`xh-tool-activity-face${frame.previous === undefined ? '' : outgoing ? ' xh-tool-activity-out' : ' xh-tool-activity-in'}`} aria-hidden={outgoing || undefined}>
    <ToolGlyph name={item.name} argsRaw={item.glyphArgs} size={14} /><span className="xh-tool-activity-name">{item.title}</span><span className="xh-tool-activity-description">{item.summary}</span>
  </span>
  return <span ref={element} className="xh-tool-activity" data-tool-activity={turn} hidden={frame.current === undefined} aria-hidden="true"
    onMouseEnter={() => { if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) setHovered(true) }} onMouseLeave={() => { setHovered(false) }}>
    <span className="xh-tool-activity-recent">{t('message.recentTool')}</span>
    <span className="xh-tool-activity-pages" data-tool-activity-pages="">
      {frame.previous !== undefined && face(frame.previous, true)}
      {frame.current !== undefined && <span key={frame.revision} className="xh-tool-activity-page" data-tool-activity-current={frame.current.key}>{face(frame.current, false)}</span>}
    </span>
    {input.parallel > 1 && <span className="xh-tool-activity-parallel" data-tool-activity-parallel={input.parallel}>{t('message.parallelTools', { count: input.parallel })}</span>}
  </span>
}
