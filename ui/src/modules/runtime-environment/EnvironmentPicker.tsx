import { useEffect, useRef, useState } from 'react'
import {
  Menu, IconChevronDownOutline14, IconFollowsystemOutline16, IconGlobeOutline14,
} from '@xharness/dsh-client-ui-primitives'
import type { RuntimeEnvironmentOwnerProps } from '../conversation/contract/slots'
import type { EnvironmentKey } from './locales'
import { canAcknowledgeLocalPick, environmentPresentation } from './policy'

export type EnvironmentPickerProps = RuntimeEnvironmentOwnerProps & {
  t: (key: EnvironmentKey) => string
}

/** Presentation only: never route a cloud pick to the local Host as fallback. */
export function EnvironmentPicker({ t, appearance, ...owner }: EnvironmentPickerProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const localLabel = useRef<HTMLSpanElement>(null)
  const presentation = environmentPresentation(owner)
  const reason = presentation === 'draft' ? undefined : t(presentation)

  // An old menu must not survive a workspace/session/history-state transition.
  useEffect(() => { setOpen(false) }, [owner.sessionId, presentation, owner.openState])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const item = localLabel.current?.closest<HTMLButtonElement>('[role="menuitem"]')
      if (item !== undefined && item !== null && !item.disabled) item.focus({ preventScroll: true })
    })
    const keydown = (event: KeyboardEvent): void => {
      const list = localLabel.current?.closest('[role="menu"]')
      if (!(event.target instanceof Node)
        || !(list?.contains(event.target) === true || trigger.current?.contains(event.target) === true)) return
      if (event.key === 'Tab') { setOpen(false); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const item = localLabel.current?.closest<HTMLButtonElement>('[role="menuitem"]')
      if (item !== undefined && item !== null && !item.disabled) item.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', keydown)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown) }
  }, [open])

  return <Menu
    open={open} portal side="bottom" selectedId="local"
    onClose={() => { setOpen(false) }}
    onSelect={id => {
      if (!canAcknowledgeLocalPick(presentation, id)) return
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }}
    items={[
      { id: 'local', disabled: presentation !== 'draft',
        icon: <IconFollowsystemOutline16 size={16} aria-hidden="true" />,
        label: <span ref={localLabel}>{t('local')}</span> },
      { id: 'cloud', disabled: true,
        icon: <IconGlobeOutline14 size={16} aria-hidden="true" />,
        label: <span>{t('cloud')}<span style={{ display: 'block', maxWidth: 280, whiteSpace: 'normal' }}>{t('unavailable')}</span></span> },
      ...(reason === undefined ? [] : [{ type: 'label' as const, id: 'binding-reason', text: reason }]),
    ]}
    anchor={<button
      ref={trigger} type="button" className={appearance.trigger}
      data-xh-runtime-environment="" data-xh-environment-presentation={presentation}
      aria-label={t('choose')} aria-haspopup="menu" aria-expanded={open}
      title={reason ?? t('unavailable')}
      onClick={() => { setOpen(value => !value) }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true)
        }
      }}
    >
      <IconFollowsystemOutline16 className={appearance.icon} size={16} aria-hidden="true" />
      <span className={appearance.label}>{t('local')}</span>
      <IconChevronDownOutline14 className={appearance.chevron} size={12} aria-hidden="true" />
    </button>}
  />
}
