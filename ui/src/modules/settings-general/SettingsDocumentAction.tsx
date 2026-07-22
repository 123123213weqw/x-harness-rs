/** Optional settings-header action for opening a file-backed Host document. */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@xharness/dsh-client-ui-primitives'
import type { PropsLocale } from '../views-types'
import type { SettingsDocumentStore } from './settings-document-store'
import css from './SettingsDocumentAction.styles'

/** Registrant-owned dependencies of {@link SettingsDocumentAction}. */
export interface SettingsDocumentActionInjected {
  /** Provider metadata and action state owner. */
  controller: SettingsDocumentStore
  hooks: {
    /** Controller snapshot bound by the UI renderer as useSnapshot. */
    snapshot: SettingsDocumentStore['store']
  }
}

/** Header-action owner share, localized copy, and the registrant's state face. */
export type SettingsDocumentActionProps =
  PropsLocale<'settings'> & {controller: SettingsDocumentStore; useSnapshot: import('./contracts').Selector<import('./settings-document-store').SettingsDocumentState>}

/**
 * Render the open-document action only after Host metadata confirms document availability.
 * @param props - header owner props, localized copy, and injected document state.
 * @returns the action, or null while unavailable or unresolved.
 */
export function SettingsDocumentAction({ controller, useSnapshot, t }: SettingsDocumentActionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  useEffect(() => {
    void controller.load()
  }, [controller])

  if (state.status !== 'ready') return null

  return (
    <div className={css.action}>
      {state.error === null ? null : <span className={css.error} role="alert">{t('openDocument.error')}</span>}
      <Button
        variant="outline"
        size="sm"
        disabled={state.opening}
        onClick={() => { void controller.open() }}
      >
        {t('openDocument')}
      </Button>
    </div>
  )
}
