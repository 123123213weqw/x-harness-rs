import { CompactionProgressCard } from './CompactionProgressCard'
// CompactionCommandCard: the `/compact` command's running row and its
// successful checkpoint disclosure. Outcomes without a checkpoint keep the
// generic command card so no-history, cancellation, and failures retain their
// complete handler-authored text.

import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots'
import { CompactionItem } from './CompactionItem'
import { GenericCommandCard } from './GenericCommandCard'

interface CompactionCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
}

/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
export function CompactionCommandCard({ node, compaction, t }: CompactionCommandCardProps) {
  if (compaction !== undefined) {
    if ('status' in compaction) return <CompactionProgressCard data={compaction} t={t} />
    return (
      <CompactionItem
        node={compaction}
        title="compact"
        fallbackSummary={node.outcome?.text ?? null}
        t={t}
      />
    )
  }
  if (node.outcome !== null) return <GenericCommandCard node={node} t={t} />
  return <GenericCommandCard node={node} t={t} runningSummary={t('message.compaction.running')} />
}
