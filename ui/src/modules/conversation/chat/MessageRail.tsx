import { memo } from 'react'
import { Tooltip } from '../primitives'
import type { ChatViewSlotProps } from '../contract/slots'
import type { MessageMarker } from './message-preview'
import css from './MessageRail.styles'

/** The navigation rail changes only with messages, reader position or locale. */
export const MessageRail = memo(function MessageRail({ markers, active, select, t }: {
  markers: readonly MessageMarker[]
  active: string | null
  select: (key: string) => void
  t: ChatViewSlotProps['t']
}) {
  return <nav className={css.root} aria-label={t('chat.messageRail')}>
    {markers.map((marker, index) => {
      const label = marker.preview === ''
        ? t('chat.messageRail.message', { n: index + 1 })
        : `${t('chat.messageRail.message', { n: index + 1 })}: ${marker.preview}`
      return <Tooltip key={marker.key} label={label} side="right" delayMs={300}>
        <button type="button" className={css.item} data-message-key={marker.key} aria-label={label}
          aria-current={active === marker.key ? 'location' : undefined} onClick={() => { select(marker.key) }}>
          <span className={css.mark} aria-hidden="true" />
        </button>
      </Tooltip>
    })}
  </nav>
})
