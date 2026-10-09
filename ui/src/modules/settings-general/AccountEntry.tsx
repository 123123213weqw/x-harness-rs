import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconChevronDownOutline14, IconDataOutline16, IconSettingsOutline16,
  IconUserOutline16, Menu,
} from '@xharness/dsh-client-ui-primitives'
import type { PropsLocale } from '../views-types'
import type { SettingsSectionRow } from './shell-contract'
import css from './AccountEntry.styles'

export type AccountEntryProps = PropsLocale<'settings'> & {
  wide: boolean
  rows: readonly SettingsSectionRow[]
  openSection: (id: string) => void
}

/** Route by stable section IDs, never translated labels. Optional features
 * disappear with their slot registration; Settings stays usable without login.
 * This entry deliberately does not infer identity from a configured API key.
 */
export function accountMenuRows(rows: readonly SettingsSectionRow[], t: PropsLocale<'settings'>['t']) {
  return [
    { id: 'managed-account', label: t('account.menu'), icon: 'account' },
    { id: 'profile', label: t('account.profile'), icon: 'profile' },
    { id: 'general', label: t('trigger'), icon: 'settings' },
  ].filter(item => rows.some(row => row.id === item.id))
}

/** A single sidebar entry, with an upward body-portal menu. Reuses Menu's
 * viewport clamp, outside-click/Escape handling and native-browser occlusion
 * semantics. Authentication continues in the existing account section.
 */
export function AccountEntry({ wide, rows, openSection, t }: AccountEntryProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const labels = useRef(new Map<string, HTMLSpanElement>())
  const firstFocus = useRef<'first' | 'last'>('first')
  const entries = accountMenuRows(rows, t)
  const buttons = () => entries.map(entry => labels.current.get(entry.id)?.closest<HTMLButtonElement>('button'))
    .filter((button): button is HTMLButtonElement => button != null && !button.disabled)
  const close = useCallback(() => setOpen(false), [])
  // A sidebar collapse settles after its fade. Re-anchor the live menu at
  // that layout commit; it must not dismiss a menu opened during the fade.
  const getAnchorRect = useCallback(() => trigger.current?.getBoundingClientRect() ?? null, [wide])
  useEffect(() => {
    if (!open) return
    // Menu measures its portal while hidden. Focus after placement is visible,
    // and cancel the frame if the entry closes/unmounts in the same commit.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== trigger.current) return
      const controls = buttons()
      const target = firstFocus.current === 'last' ? controls.at(-1) : controls[0]
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
    // Opening focus is a view transition, not a reaction to locale/ledger changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return <span ref={root} className={css.root} data-xh-account-entry=""
    onMouseDownCapture={event => {
      if (event.button !== 0 || !(event.target instanceof Node)) return
      const target = event.target
      const button = trigger.current?.contains(target) ? trigger.current
        : buttons().find(control => control.contains(target))
      if (!button) return
      // Normalize pointer focus before blur can dismiss the portal. Safari
      // otherwise blurs to the body and removes the item before its click.
      event.preventDefault()
      button.focus()
    }}
    onBlur={event => {
      const next = event.relatedTarget
      if (next instanceof Node && (root.current?.contains(next) || buttons().some(button => button.contains(next)))) return
      close()
    }}
    onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      if (!open) {
        firstFocus.current = event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first'
        setOpen(true)
        return
      }
      const controls = buttons()
      if (controls.length === 0) return
      const current = controls.findIndex(button => button === document.activeElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
        : current < 0 ? (event.key === 'ArrowDown' ? 0 : controls.length - 1)
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length
      controls[index]?.focus()
    }}>
    <Menu open={open} portal side="top" className={css.menuAnchor} getAnchorRect={getAnchorRect}
      onClose={close} onSelect={section => {
        if (!entries.some(entry => entry.id === section)) return
        // The menu item is about to unmount. Give the modal a durable opener
        // so closing Settings restores focus to this sidebar entry.
        trigger.current?.focus()
        close()
        openSection(section)
      }}
      items={[
        { type: 'label', id: 'identity', text: t('account.local') },
        ...entries.map(entry => ({ id: entry.id,
          label: <span ref={element => { if (element) labels.current.set(entry.id, element); else labels.current.delete(entry.id) }}
            className={css.menuLabel}>{entry.label}</span>,
          icon: entry.icon === 'account' ? <IconUserOutline16 size={16} />
            : entry.icon === 'profile' ? <IconDataOutline16 size={16} /> : <IconSettingsOutline16 size={16} />,
        })),
      ]}
      anchor={<button ref={trigger} type="button" className={`${css.trigger} ${!wide ? css.rail : ''}`}
        aria-label={t('account.trigger')} aria-haspopup="menu" aria-expanded={open}
        title={!wide ? t('account.trigger') : undefined} data-xh-account-trigger=""
        onClick={() => {
          // WebKit does not focus buttons on pointer clicks by default. Give
          // the opening transition the same focus anchor as keyboard input.
          trigger.current?.focus()
          firstFocus.current = 'first'
          setOpen(value => !value)
        }}>
        <span className={css.avatar} aria-hidden="true"><IconUserOutline16 size={18} /></span>
        {wide && <><span className={css.identity}><span className={css.name}>{t('account.name')}</span>
          <span className={css.caption}>{t('account.caption')}</span></span>
          <IconChevronDownOutline14 size={14} className={css.chevron} /></>}
      </button>} />
  </span>
}
