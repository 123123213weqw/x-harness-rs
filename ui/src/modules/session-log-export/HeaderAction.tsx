import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  IconBrowseOutline16, IconDownloadOutline16, IconListPenOutline16, IconQuestionOutline14, Menu,
} from '@xharness/dsh-client-ui-primitives'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog'
import css from './HeaderAction.styles'

const DOCUMENTATION = 'https://github.com/123123213weqw/XHarness#readme'
const REPORT_ISSUE = 'https://github.com/123123213weqw/XHarness/issues/new/choose'

function openSupportLink(href: typeof DOCUMENTATION | typeof REPORT_ISSUE): void {
  // Fixed destinations, never populated with Session IDs, logs or user data.
  const link = document.createElement('a')
  link.href = href
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.click()
}

/** The menu belongs to one Session. Its result dialog also serves /export. */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadDialogProps): ReactNode {
  return <SessionHelpMenu key={props.sessionId} {...props} />
}

function SessionHelpMenu(props: SessionLogDownloadDialogProps): ReactNode {
  const { sessionId, useSessionLogDownload, request, t } = props
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const focusLast = useRef(false)
  const entry = useSessionLogDownload(state => state.bySession[sessionId])
  const busy = entry?.status === 'downloading'
  const showMenu = open && entry?.open !== true
  const close = useCallback(() => { setOpen(false) }, [])
  const choices = useCallback(() =>
    Array.from(document.getElementById(menuId)?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []),
  [menuId])

  useEffect(() => {
    if (!showMenu) return
    // The portaled menu measures itself hidden first; wait until it is placed.
    const frame = window.requestAnimationFrame(() => {
      const rows = choices()
      rows.at(focusLast.current ? -1 : 0)?.focus({ preventScroll: true })
    })
    return () => { window.cancelAnimationFrame(frame) }
  }, [showMenu, choices])
  useEffect(() => { if (entry?.open === true) close() }, [entry?.open, close])

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (!open && event.target === trigger.current && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      focusLast.current = event.key === 'ArrowUp'
      setOpen(true)
      return
    }
    if (!open) return
    if (event.key === 'Tab') {
      close()
      trigger.current?.focus({ preventScroll: true })
      return
    }
    const rows = choices()
    if (rows.length === 0) return
    const current = rows.findIndex(row => row === document.activeElement)
    let next: number
    if (event.key === 'ArrowDown') next = (current + 1) % rows.length
    else if (event.key === 'ArrowUp') next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else return
    event.preventDefault()
    rows[next]?.focus()
  }

  return <>
    <span className={css.root} onKeyDown={onKeyDown}>
      <Menu id={menuId} label={t('help.label')} listClassName={css.helpMenu} open={showMenu} portal dense align="end" onClose={close}
        items={[
          { id: 'docs', label: t('help.docs'), icon: <IconBrowseOutline16 /> },
          { id: 'issue', label: t('help.issue'), icon: <IconListPenOutline16 /> },
          { type: 'separator', id: 'diagnostics' },
          { id: 'export', label: t('help.export'), icon: <IconDownloadOutline16 />, disabled: busy },
        ]}
        onSelect={id => {
          close()
          trigger.current?.focus({ preventScroll: true })
          if (id === 'docs') openSupportLink(DOCUMENTATION)
          else if (id === 'issue') openSupportLink(REPORT_ISSUE)
          else if (id === 'export' && !busy) void request(sessionId)
        }}
        anchor={<button ref={trigger} type="button" className={css.helpButton}
          title={t('help.label')} aria-label={t('help.label')} aria-haspopup="menu" aria-expanded={showMenu}
          aria-controls={showMenu ? menuId : undefined} onClick={() => {
            focusLast.current = false
            setOpen(value => !value)
          }}>
          <IconQuestionOutline14 size={16} />
        </button>}
      />
    </span>
    <SessionLogDownloadDialog {...props} />
  </>
}
