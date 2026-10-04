/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useEffect, useRef } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '../primitives'
import type { ChatViewSlotProps } from '../contract/slots'
import { useThrottledVisualUpdate } from './use-throttled-visual-update'
import a11yCss from './accessibility.styles'
import css from './ReasoningRow.styles'
import { useTranscriptState } from './transcript-state'
import { useProcessMode } from './process-mode'

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Render one assistant reasoning block as the Think disclosure row.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, t, stateKey = 0 }: { text: string; running: boolean; stateKey?: number; t: ChatViewSlotProps['t'] }) {
  const [expanded, setExpanded] = useTranscriptState(`reasoning:${stateKey}`, false)
  const processMode = useProcessMode()
  const [appliedMode, setAppliedMode] = useTranscriptState(`reasoning-mode:${stateKey}`, null)
  useEffect(() => {
    if (appliedMode === processMode) return
    setAppliedMode(processMode)
    setExpanded(processMode === 'expanded')
  }, [processMode, appliedMode, setAppliedMode, setExpanded])
  const summaryRef = useRef<HTMLSpanElement>(null)
  const summary = running ? latestLine(text) : firstLine(text)
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [running, scheduleSummaryScroll, summary])

  return (
    <div className={css.root} data-variant="think" data-state={running ? 'running' : 'ok'}>
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title="Think"
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span ref={summaryRef} className={css.summary} data-follow-end={running || undefined}>{summary}</span>
          </>
        )}
      >
        <div className={css.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  )
}
