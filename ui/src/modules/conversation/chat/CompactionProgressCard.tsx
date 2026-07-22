import type { CompactionPendingNode } from '../conversation-nodes/compaction-lifecycle'
import type { ChatViewSlotProps } from '../contract/slots'
import { IconApiOutline14, IconChevronDownOutline14, IconChevronRightOutline14 } from '../primitives'
import { useTranscriptState } from './transcript-state'
import css from './MessageItem.styles'

/** Minimal status; runtime owns all durable progress, waits and recovery. */
export function CompactionProgressCard({ data, t }: { data: CompactionPendingNode; t: ChatViewSlotProps['t'] }) {
  const [open, setOpen] = useTranscriptState('compact-progress', false)
  const active = data.status === 'running'
  const paused = active && data.progress?.stage === 'paused'
  const title = paused ? t('xh.compact.paused') : active ? t('message.compaction.running') : t('xh.compact.failed')
  const detail = paused ? t('xh.compact.resume') : active ? t('xh.compact.takesMinutes') : t('xh.compact.unchanged')
  const content = <><IconApiOutline14 aria-hidden /><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{title} · {detail}</span></>
  return <div className={css.compactionRow} data-compaction-progress data-compaction-running={active || undefined}
    data-active={active || undefined} data-state={active ? 'running' : 'error'} data-stage={data.progress?.stage}
    style={{ display: 'block', width: '100%', minWidth: 0 }}>
    {active ? <div role="status" aria-live="polite" aria-atomic
      style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>{content}</div>
      : <div role="alert"><button type="button" className={css.compactionButton} aria-expanded={open} disabled={!data.error}
        onClick={() => { setOpen(value => !value) }} style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0' }}>
        {content}{data.error && (open ? <IconChevronDownOutline14 aria-hidden /> : <IconChevronRightOutline14 aria-hidden />)}
      </button></div>}
    {!active && open && data.error && <div style={{ padding: '4px 0 10px 22px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }}>{data.error}</div>}
  </div>
}
