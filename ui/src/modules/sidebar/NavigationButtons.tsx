import { useSyncExternalStore } from 'react'
import type { ShellNavigationControls } from '../layout/shell-navigation'
import type { Translation } from '../views-types'

/** Small, ordinary buttons: disabled is native (including keyboard behavior).
 * No document-global shortcuts that steal the editor or browser's arrows. */
export function NavigationButtons({ navigation, t, desktop = false }: {
  navigation: ShellNavigationControls; t: Translation; desktop?: boolean
}) {
  const state = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
  return <span className={`xh-shell-navigation${desktop ? ' xh-shell-navigation-desktop' : ''}`} data-shell-navigation>
    <button type="button" aria-label={t('navigation.back')} title={t('navigation.back')}
      disabled={!state.canBack} onClick={navigation.back} data-shell-navigation-back>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M20 12H4m7-7-7 7 7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    <button type="button" aria-label={t('navigation.forward')} title={t('navigation.forward')}
      disabled={!state.canForward} onClick={navigation.forward} data-shell-navigation-forward>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 12h16m-7-7 7 7-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  </span>
}
