/** Stable context-ring seat. Occupancy is a reading; category distribution is an estimate. */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { UseProjection } from '../types/runtime'
import { Tooltip } from '../primitives'
import type { ComposerBarProps } from '../contract/slots'
import { contextOccupancy, formatTokens } from '../chat/StatsLine'
import css from './ContextMeter.styles'
const RADIUS = 5.5, CIRCUMFERENCE = 2 * Math.PI * RADIUS
const ROWS = [
  { key: 'systemTokens', label: 'context.system', tint: '#8290a5' },
  { key: 'userTokens', label: 'context.user', tint: '#3b82f6' },
  { key: 'assistantTokens', label: 'context.assistant', tint: '#20a887' },
  { key: 'toolResultTokens', label: 'context.toolResults', tint: '#e1a63b' },
  { key: 'toolDefinitionTokens', label: 'context.tools', tint: '#a78bfa' },
  { key: 'mcpToolDefinitionTokens', label: 'context.mcp', tint: '#c770ca' },
  { key: 'protocolTokens', label: 'context.protocol', tint: '#9b9b9b' },
] as const
export interface ContextMeterProps { useProjection: UseProjection; t: ComposerBarProps['t'] }
interface Segment { key: string; label?: (typeof ROWS)[number]['label']; tint: string; ratio: number }
function tintStyle(tint: string, width?: string): CSSProperties & { '--meter-tint': string } { return { '--meter-tint': tint, ...(width === undefined ? {} : { width }) } }
export function ContextMeter({ useProjection, t }: ContextMeterProps) {
  const pressure = useProjection('contextPressure'), composition = pressure?.composition
  const [open, setOpen] = useState(false), rootRef = useRef<HTMLSpanElement>(null)
  const context = contextOccupancy(pressure), available = context !== null
  useEffect(() => { if (!available && open) setOpen(false) }, [available, open])
  useEffect(() => {
    if (!open || !available) return
    const pointer = (event: PointerEvent): void => { if (event.target instanceof Node && rootRef.current?.contains(event.target)) return; setOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', escape) }
  }, [available, open])
  const weight = available && composition ? ROWS.reduce((total, row) => total + (Number.isSafeInteger(composition[row.key]) && composition[row.key] > 0 ? composition[row.key] : 0), 0) : 0
  const percent = context?.percent ?? 0
  const reading = available ? (context.exact ? '' : '≈') + percent + '%' : null
  const label = available ? t('context.aria', { percent: reading }) : t(['preparing', 'in_flight', 'model_changed'].includes(pressure?.phase ?? '') ? 'context.pending' : 'context.unavailable')
  const segments: Segment[] = weight > 0 && composition ? ROWS.filter(row => composition[row.key] > 0).map(row => ({ ...row, ratio: composition[row.key] / weight })) : [{ key: 'total', tint: 'currentColor', ratio: 1 }]
  let offset = 0
  const ring = segments.map(segment => {
    const length = CIRCUMFERENCE * percent / 100 * segment.ratio, start = offset
    offset += length
    return <circle key={segment.key} className={css.fill} cx="7" cy="7" r={RADIUS} stroke={segment.tint} strokeDasharray={`${length} ${CIRCUMFERENCE}`} strokeDashoffset={-start} transform="rotate(-90 7 7)" />
  })
  return <span ref={rootRef} className={css.root}>
    <Tooltip label={label} side="top" delayMs={200} disabled={open}>
      <button type="button" className={css.trigger} aria-label={label} aria-haspopup={available ? 'dialog' : undefined} aria-expanded={available ? open : undefined} disabled={!available} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden><circle className={css.track} cx="7" cy="7" r={RADIUS} />{ring}</svg>
      </button>
    </Tooltip>
    {open && context && <div className={css.panel} role="dialog" aria-label={t('context.used')}>
      <div className={css.header}><span className={css.headline}>{context.label}</span><span className={css.percent}>{reading}</span><span className={css.figures}>{`${context.exact ? '' : '≈'}${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`}</span></div>
      <div className={css.bar}>{segments.map(row => <div key={row.key} className={css.segment} style={tintStyle(row.tint, `${percent * row.ratio}%`)} />)}</div>
      {weight > 0 && <dl className={css.rows}>
        <div className={css.headline}>{t('context.distributionEstimate')}</div>
        {segments.map(row => <div key={row.key} className={css.row}><dt><span className={css.swatch} style={tintStyle(row.tint)} aria-hidden />{row.label ? t(row.label) : ''}</dt><dd>{`≈${formatTokens(Math.round(context.usedTokens * row.ratio))}`}</dd></div>)}
      </dl>}
    </div>}
  </span>
}
