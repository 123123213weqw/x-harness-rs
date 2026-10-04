/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useEffect, useRef } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '../primitives'
import type { ChatViewSlotProps } from '../contract/slots'
import { useThrottledVisualUpdate } from './use-throttled-visual-update'
import a11yCss from './accessibility.styles'
import css from './ReasoningRow.styles'
import { useTranscriptState } from './transcript-state'
import { useProcessMode } from './process-mode'
import { firstReasoningLine } from './reasoning-summary'
import { useReasoningSummary } from './use-reasoning-summary'

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
  const preview = useReasoningSummary(text, running && !expanded)
  const summary = running ? preview.current : firstReasoningLine(text)
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running && !preview.paging ? element.scrollWidth - element.clientWidth : 0
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [running, preview.paging, scheduleSummaryScroll, summary])

  return (
    <div className={css.root} data-variant="think" data-state={running ? 'running' : 'ok'} data-preview={preview.paging ? 'paged' : undefined}>
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
            <span ref={summaryRef} className={css.summary} data-follow-end={running && !preview.paging || undefined} data-paging={preview.paging || undefined}>
              {preview.paging ? (
                <span key={preview.revision} className={css.page} data-flipping={preview.previous !== undefined || undefined}>
                  {preview.previous !== undefined && <span className={css.pageOut} aria-hidden>{preview.previous}</span>}
                  <span className={css.pageIn}>{summary}</span>
                </span>
              ) : summary}
            </span>
          </>
        )}
      >
        <div className={css.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  )
}
