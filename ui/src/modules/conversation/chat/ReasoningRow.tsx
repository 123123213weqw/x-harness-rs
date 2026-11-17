/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useEffect } from 'react'
import { DisclosureRow, IconChevronRightOutline14 } from '../primitives'
import type { ChatViewSlotProps } from '../contract/slots'
import a11yCss from './accessibility.styles'
import css from './ReasoningRow.styles'
import { useTranscriptState } from './transcript-state'
import { useProcessMode } from './process-mode'
import { firstReasoningLine } from './reasoning-summary'
import { ToolGlyph } from '../../shared/ToolGlyph'

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
  }, [processMode, appliedMode, setExpanded, setExpanded])
  // Streaming preview is a tail window beside the row's timeline edge: the
  // newest reasoning fragment stays visible in place — no marquee scrolling
  // and no paging flip. Settled rows keep the first line as the summary.
  const flat = text.replace(/\s+/g, ' ')
  const summary = running && !expanded
    ? (flat.length > 72 ? '…' + flat.slice(-72) : flat)
    : firstReasoningLine(text)

  return (
    <div className={css.root} data-variant="think" data-state={running ? 'running' : 'ok'}>
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<ToolGlyph kind="thought" size={14} />}
        title="Thought"
        open={expanded}
        expandable
        expandOnRowClick
        keepIconWhenOpen
        previewChevron={false}
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary}>{summary}</span>
            <span className="xh-thought-chevron" aria-hidden="true"><IconChevronRightOutline14 /></span>
          </>
        )}
      >
        <div className={css.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  )
}
